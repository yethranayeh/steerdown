import type { Edge, Graph, GraphSection } from "./graph.ts";
import type { JevClient } from "./jev.ts";
import type { Section, SkippedSection } from "./sections.ts";

import { createHash } from "node:crypto";
import { readPageIds } from "./anchors.ts";
import { graphVersion, readGraph, relations, writeGraph } from "./graph.ts";
import { askJev, officialEndpoint, runPooled } from "./jev.ts";
import { rankLinks } from "./rank.ts";
import { findMarkdownFiles, readSections } from "./sections.ts";
import { cosine, tfidfVectors } from "./similarity.ts";

export type BuildOptions = {
  directory: string;
  outPath: string;
  htmlDirectory: string | undefined;
  excluded: Array<string>;
  /** Files and folders, relative to `directory`, that each cover their own product. */
  scopes: Array<string>;
  maxPairs: number;
  client: JevClient;
};

export type BuildReport = {
  pages: number;
  sections: number;
  skipped: Array<SkippedSection>;
  pairs: number;
  reused: number;
  judged: number;
  requests: number;
  inputTokens: number;
};

export class BuildError extends Error {}

export const defaultMaxPairs = 100_000;
const model = "jev-latest";
const candidatesPerRequest = 16;
const requestsInFlight = 4;
const judgedWordLimit = 600;

const relationCriteria: Record<(typeof relations)[number], string> = {
  prerequisite: "Explains something the reader needs to understand before `reading` makes sense.",
  next_step:
    "A natural thing to read right after `reading`, continuing the same task or using what it explains.",
  detail: "Reference detail for something `reading` mentions (flags, fields, formats, settings).",
  alternative: "A different way to reach the same goal as `reading`.",
  unrelated: "Shares words, but a reader of `reading` would gain nothing from it.",
};

const relationInstructions = (candidate: number) =>
  `A reader has just finished the documentation section in \`reading\`. What is the section in \`candidates\` with n = ${candidate} to that reader?`;

const questionSetHash = hash([model, judgedWordLimit, relationInstructions(0), relationCriteria]);

function hash(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
}

function judgedText(text: string) {
  const words = text.split(/\s+/);

  return words.length > judgedWordLimit ? words.slice(0, judgedWordLimit).join(" ") : text;
}

function judgedState(section: Section) {
  return {
    page_title: section.pageTitle,
    heading: section.heading,
    text: judgedText(section.text),
  };
}

/** Leaves out sections the built HTML gives no anchor to link to. */
function keepLinkableSections(
  sections: Array<Section>,
  htmlDirectory: string,
): { linkable: Array<Section>; skipped: Array<SkippedSection> } {
  const idsByPage = new Map<string, Set<string> | undefined>();
  const linkable: Array<Section> = [];
  const skipped: Array<SkippedSection> = [];
  for (const section of sections) {
    if (!idsByPage.has(section.page)) {
      idsByPage.set(section.page, readPageIds(htmlDirectory, section.page));
    }
    const pageIds = idsByPage.get(section.page);
    if (pageIds === undefined) {
      skipped.push({ id: section.id, reason: "no built HTML page" });
      continue;
    }
    const anchor = section.id.slice(section.page.length + 1);
    const isPageIntro = section.heading === "";
    if (!isPageIntro && !pageIds.has(anchor)) {
      skipped.push({ id: section.id, reason: "no matching id in the built HTML" });
      continue;
    }
    linkable.push(section);
  }
  return { linkable, skipped };
}

type Judgment = { relation: string; probabilities: number[]; confidence: number };

const round = (value: number) => Math.round(value * 1000) / 1000;

/** Judgments from an earlier graph, keyed by the hashes of both sections, when its questions match. */
function reusableJudgments(previous: Graph | undefined): Map<string, Judgment> {
  const judgments = new Map<string, Judgment>();
  if (previous === undefined || previous.questions !== questionSetHash) {
    return judgments;
  }
  for (const [from, to, relation, probabilities, confidence] of previous.edges) {
    const fromSection = previous.sections[from];
    const toSection = previous.sections[to];
    if (fromSection && toSection) {
      judgments.set(`${fromSection.hash}>${toSection.hash}`, {
        relation,
        probabilities,
        confidence,
      });
    }
  }
  return judgments;
}

/**
 * Splits the Markdown under a directory into sections, judges every pair of sections on different
 * pages with Jev, and writes the graph file. Pairs whose text is unchanged since the last graph
 * file are reused, not judged again. When a request fails, the pairs judged so far are written
 * before the error is thrown, so the next run continues from there.
 */
export async function build(options: BuildOptions): Promise<BuildReport> {
  const pages = findMarkdownFiles(options.directory, options.excluded);
  const read = readSections(options.directory, pages);
  let sections = read.sections;
  const skipped = [...read.skipped];
  if (options.htmlDirectory !== undefined) {
    const anchored = keepLinkableSections(sections, options.htmlDirectory);
    sections = anchored.linkable;
    skipped.push(...anchored.skipped);
  }

  const hashes = sections.map((section) => hash(judgedState(section)));
  const previous = readGraph(options.outPath);
  const judgments = reusableJudgments(previous);
  const pairKey = (from: number, to: number) => `${hashes[from]}>${hashes[to]}`;

  // Candidates are batched in order of word similarity to the section being read, so each request
  // compares a section with its nearest neighbours first. The judge's labels depend on which
  // candidates share a request.
  const vectors = tfidfVectors(sections.map((section) => section.text));
  let pairs = 0;
  const jobs: { from: number; targets: number[] }[] = [];
  sections.forEach((reading, from) => {
    const missing: { to: number; similarity: number }[] = [];
    sections.forEach((candidate, to) => {
      if (candidate.page === reading.page) {
        return;
      }
      pairs++;
      if (!judgments.has(pairKey(from, to))) {
        missing.push({ to, similarity: cosine(vectors[from]!, vectors[to]!) });
      }
    });
    missing.sort((first, second) => second.similarity - first.similarity || first.to - second.to);
    const targets = missing.map(({ to }) => to);
    for (let start = 0; start < targets.length; start += candidatesPerRequest) {
      jobs.push({ from, targets: targets.slice(start, start + candidatesPerRequest) });
    }
  });
  const toJudge = jobs.reduce((count, job) => count + job.targets.length, 0);

  if (toJudge > options.maxPairs) {
    throw new BuildError(
      `${toJudge} section pairs need judging, more than the limit of ${options.maxPairs}. Raise it with --max-pairs.`,
    );
  }
  const keyNeeded =
    toJudge > 0 &&
    options.client.endpoint === officialEndpoint &&
    options.client.apiKey === undefined;
  if (keyNeeded) {
    throw new BuildError(
      `${toJudge} section pairs need judging. Set TYPESAFE_API_KEY to judge them.`,
    );
  }

  let responseModel = previous?.model ?? model;
  let requests = 0;
  let inputTokens = 0;
  let judged = 0;
  let failure: unknown;
  try {
    await runPooled(jobs, requestsInFlight, async ({ from, targets }) => {
      const questions: Record<string, object> = {};
      targets.forEach((_, index) => {
        questions[`relation_${index + 1}`] = {
          type: "choice",
          instructions: relationInstructions(index + 1),
          criteria: relationCriteria,
        };
      });
      const state = {
        reading: judgedState(sections[from]!),
        candidates: targets.map((to, index) => ({ n: index + 1, ...judgedState(sections[to]!) })),
      };
      const response = await askJev(options.client, { model, state, questions });
      requests++;
      inputTokens += response.usage.input_tokens;
      responseModel = response.model;
      targets.forEach((to, index) => {
        const answer = response.answers[`relation_${index + 1}`];
        if (answer === undefined) {
          return;
        }
        judgments.set(pairKey(from, to), {
          relation: answer.choice,
          probabilities: relations.map((relation) => round(answer.probabilities[relation] ?? 0)),
          confidence: round(answer.confidence),
        });
        judged++;
      });
    });
  } catch (error) {
    failure = error;
  }

  const graphSections: Array<GraphSection> = sections.map((section, index) => ({
    id: section.id,
    page: section.page,
    pageTitle: section.pageTitle,
    heading: section.heading,
    hash: hashes[index]!,
  }));
  const edges: Array<Edge> = [];
  sections.forEach((reading, from) => {
    sections.forEach((candidate, to) => {
      const judgment =
        candidate.page === reading.page ? undefined : judgments.get(pairKey(from, to));
      if (judgment) {
        edges.push([from, to, judgment.relation, judgment.probabilities, judgment.confidence]);
      }
    });
  });
  writeGraph(options.outPath, {
    version: graphVersion,
    model: responseModel,
    questions: questionSetHash,
    relations,
    sections: graphSections,
    skipped,
    edges,
    links: rankLinks(graphSections, edges, options.scopes),
  });

  if (failure !== undefined) {
    const message = failure instanceof Error ? failure.message : String(failure);
    throw new BuildError(
      `${message}\nWrote the ${edges.length} of ${pairs} pairs judged so far to ${options.outPath}. Run the build again to judge the rest.`,
    );
  }
  return {
    pages: pages.length,
    sections: sections.length,
    skipped,
    pairs,
    reused: pairs - toJudge,
    judged,
    requests,
    inputTokens,
  };
}
