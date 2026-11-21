import type { Edge, Graph, GraphSection } from "./graph.ts";
import type { JevClient, JevResponse } from "./jev.ts";
import type { RequestProgress } from "./judge.ts";
import type { ScoreReport, ScoreRun } from "./scores.ts";
import type { Section, SkippedSection } from "./sections.ts";

import { readPageIds } from "./anchors.ts";
import { conceptFilePath, readConceptFile } from "./concepts.ts";
import { ReportedError } from "./errors.ts";
import { graphVersion, readGraph, relations, writeGraph } from "./graph.ts";
import { askJev, officialEndpoint, runPooled } from "./jev.ts";
import { hash, judgedState, judgedWordLimit, model, requestsInFlight, round } from "./judge.ts";
import { rankLinks } from "./rank.ts";
import { planScores, scoreConcepts } from "./scores.ts";
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
  /** Present when the build read a concept file. */
  scores: ScoreReport | undefined;
};

export class BuildError extends ReportedError {}

export const defaultMaxPairs = 100_000;
const candidatesPerRequest = 16;

const relationCriteria: Record<(typeof relations)[number], string> = {
  prerequisite: "Explains something the reader needs to understand before `reading` makes sense.",
  next_step:
    "A natural thing to read right after `reading`, continuing the same task or using what it explains.",
  detail: "Reference detail for something `reading` mentions (flags, fields, formats, settings).",
  alternative: "A different way to reach the same goal as `reading`.",
  unrelated: "Shares words, but a reader of `reading` would gain nothing from it.",
};

function relationInstructions(candidateNumber: number) {
  return `A reader has just finished the documentation section in \`reading\`. What is the section in \`candidates\` with n = ${candidateNumber} to that reader?`;
}

const questionSetHash = hash([model, judgedWordLimit, relationInstructions(0), relationCriteria]);

type Judgment = { relation: string; probabilities: Array<number>; confidence: number };

/** One request: the section being read and the candidates judged against it. */
type RequestJob = { from: number; targets: Array<number> };

type JudgingProgress = RequestProgress & { model: string; judged: number };

/** The key a judgment is stored under: the hashes of the section read and the candidate. */
function pairKey(fromHash: string, toHash: string) {
  return `${fromHash}>${toHash}`;
}

/** Candidates are numbered from 1 in a request, and each has its own question. */
function questionKey(candidateNumber: number) {
  return `relation_${candidateNumber}`;
}

/** The heading slug after the `#` in a section id. */
function headingAnchor(section: Section) {
  return section.id.slice(`${section.page}#`.length);
}

/** Why the built HTML gives a section no anchor to link to, or undefined when it does. */
function unlinkableReason(section: Section, pageIds: Set<string> | undefined) {
  if (pageIds === undefined) {
    return "no built HTML page";
  }
  const isPageIntro = section.heading === "";
  if (isPageIntro || pageIds.has(headingAnchor(section))) {
    return undefined;
  }
  return "no matching id in the built HTML";
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
    const reason = unlinkableReason(section, idsByPage.get(section.page));
    if (reason === undefined) {
      linkable.push(section);
    } else {
      skipped.push({ id: section.id, reason });
    }
  }
  return { linkable, skipped };
}

/** Reads every page's sections, leaving out link hubs and, given the built HTML, unlinkable ones. */
function readBuildSections(
  options: BuildOptions,
  pages: Array<string>,
): { sections: Array<Section>; skipped: Array<SkippedSection> } {
  const read = readSections(options.directory, pages);
  if (options.htmlDirectory === undefined) {
    return read;
  }
  const anchored = keepLinkableSections(read.sections, options.htmlDirectory);
  return { sections: anchored.linkable, skipped: [...read.skipped, ...anchored.skipped] };
}

/** Judgments from an earlier graph, keyed by the hashes of both sections, when its questions match. */
function reusableJudgments(previous: Graph | undefined): Map<string, Judgment> {
  const judgments = new Map<string, Judgment>();
  if (previous === undefined || previous.questions !== questionSetHash) {
    return judgments;
  }
  for (const [from, to, relation, probabilities, confidence] of previous.edges) {
    const fromSection = previous.sections[from];
    const toSection = previous.sections[to];
    if (fromSection !== undefined && toSection !== undefined) {
      judgments.set(pairKey(fromSection.hash, toSection.hash), {
        relation,
        probabilities,
        confidence,
      });
    }
  }
  return judgments;
}

/** The indexes of the sections a section is judged against: every section on another page. */
function candidatesOf(sections: Array<Section>, from: number): Array<number> {
  const candidates: Array<number> = [];
  sections.forEach((candidate, to) => {
    if (candidate.page !== sections[from]!.page) {
      candidates.push(to);
    }
  });
  return candidates;
}

/** Counts the ordered pairs of sections on different pages. */
function countPairs(sections: Array<Section>) {
  let pairs = 0;
  sections.forEach((_, from) => {
    pairs += candidatesOf(sections, from).length;
  });
  return pairs;
}

/** Splits a list into consecutive batches of at most `size` items. */
function inBatches<T>(items: Array<T>, size: number): Array<Array<T>> {
  const batches: Array<Array<T>> = [];
  for (let start = 0; start < items.length; start += size) {
    batches.push(items.slice(start, start + size));
  }
  return batches;
}

/**
 * Plans the requests for every pair without a judgment. Each section's candidates are batched in
 * order of word similarity to it, so each request compares a section with its nearest neighbours
 * first. The judge's labels depend on which candidates share a request.
 */
function planRequests(
  sections: Array<Section>,
  isJudged: (from: number, to: number) => boolean,
): Array<RequestJob> {
  const vectors = tfidfVectors(sections.map((section) => section.text));
  const jobs: Array<RequestJob> = [];
  sections.forEach((_, from) => {
    const missing = candidatesOf(sections, from)
      .filter((to) => !isJudged(from, to))
      .map((to) => ({ to, similarity: cosine(vectors[from]!, vectors[to]!) }));
    missing.sort((first, second) => second.similarity - first.similarity || first.to - second.to);
    const targets = missing.map(({ to }) => to);
    for (const batch of inBatches(targets, candidatesPerRequest)) {
      jobs.push({ from, targets: batch });
    }
  });
  return jobs;
}

/** Stops the build before judging when there are too many pairs or no API key to ask Jev. */
function checkJudgingAllowed(toJudge: number, toScore: number, options: BuildOptions) {
  if (toJudge > options.maxPairs) {
    throw new BuildError(
      `${toJudge} section pairs need judging, more than the limit of ${options.maxPairs}. Raise it with --max-pairs.`,
    );
  }
  const keyNeeded =
    toJudge + toScore > 0 &&
    options.client.endpoint === officialEndpoint &&
    options.client.apiKey === undefined;
  if (keyNeeded) {
    throw new BuildError(
      `${toJudge} section pairs need judging and ${toScore} concept scores need scoring. Set TYPESAFE_API_KEY to ask Jev.`,
    );
  }
}

/** The System One request body that asks how each target relates to the section being read. */
function relationRequest(job: RequestJob, sections: Array<Section>) {
  const questions: Record<string, object> = {};
  job.targets.forEach((_, index) => {
    const candidateNumber = index + 1;
    questions[questionKey(candidateNumber)] = {
      type: "choice",
      instructions: relationInstructions(candidateNumber),
      criteria: relationCriteria,
    };
  });
  const state = {
    reading: judgedState(sections[job.from]!),
    candidates: job.targets.map((to, index) => ({ n: index + 1, ...judgedState(sections[to]!) })),
  };
  return { model, state, questions };
}

/** Stores the judgment for each target the response answered and returns how many it answered. */
function recordAnswers({
  job,
  response,
  hashes,
  judgments,
}: {
  job: RequestJob;
  response: JevResponse;
  hashes: Array<string>;
  judgments: Map<string, Judgment>;
}): number {
  let answered = 0;
  job.targets.forEach((to, index) => {
    const answer = response.answers[questionKey(index + 1)];
    if (answer === undefined) {
      return;
    }
    judgments.set(pairKey(hashes[job.from]!, hashes[to]!), {
      relation: answer.choice,
      probabilities: relations.map((relation) => round(answer.probabilities[relation] ?? 0)),
      confidence: round(answer.confidence),
    });
    answered++;
  });
  return answered;
}

/** Sends the planned requests and stores their judgments, stopping at the first failed request. */
async function judgePairs({
  jobs,
  sections,
  hashes,
  judgments,
  client,
  previousModel,
}: {
  jobs: Array<RequestJob>;
  sections: Array<Section>;
  hashes: Array<string>;
  judgments: Map<string, Judgment>;
  client: JevClient;
  previousModel: string;
}): Promise<JudgingProgress> {
  const progress: JudgingProgress = {
    model: previousModel,
    requests: 0,
    inputTokens: 0,
    judged: 0,
    failure: undefined,
  };
  try {
    await runPooled(jobs, requestsInFlight, async (job) => {
      const response = await askJev(client, relationRequest(job, sections));
      progress.requests++;
      progress.inputTokens += response.usage.input_tokens;
      progress.model = response.model;
      progress.judged += recordAnswers({ job, response, hashes, judgments });
    });
  } catch (error) {
    progress.failure = error;
  }
  return progress;
}

/** The judged pairs as graph edges, in order of the section read and then the candidate. */
function collectEdges(
  sections: Array<Section>,
  hashes: Array<string>,
  judgments: Map<string, Judgment>,
): Array<Edge> {
  const edges: Array<Edge> = [];
  sections.forEach((_, from) => {
    for (const to of candidatesOf(sections, from)) {
      const judgment = judgments.get(pairKey(hashes[from]!, hashes[to]!));
      if (judgment !== undefined) {
        edges.push([from, to, judgment.relation, judgment.probabilities, judgment.confidence]);
      }
    }
  });
  return edges;
}

/** Throws the error that stopped judging or scoring, saying how much was written before it. */
function throwFailure({
  failure,
  edges,
  pairs,
  scores,
  outPath,
}: {
  failure: unknown;
  edges: Array<Edge>;
  pairs: number;
  scores: ScoreRun;
  outPath: string;
}): never {
  const message = failure instanceof Error ? failure.message : String(failure);
  const { fields, report } = scores;
  const scoresWritten =
    report === undefined ? "" : ` and ${fields.scores?.length} of ${report.total} scores`;
  throw new BuildError(
    `${message}\nWrote the ${edges.length} of ${pairs} pairs${scoresWritten} done so far to ${outPath}. Run the build again to do the rest.`,
  );
}

/**
 * Splits the Markdown under a directory into sections, judges every pair of sections on different
 * pages with Jev, scores every section against the concept file's concepts when there is one, and
 * writes the graph file. Pairs and scores whose text is unchanged since the last graph file are
 * reused, not asked again. When a request fails, the results so far are written before the error
 * is thrown, so the next run continues from there.
 */
export async function build(options: BuildOptions): Promise<BuildReport> {
  const concepts = readConceptFile(conceptFilePath(options.outPath));
  const pages = findMarkdownFiles(options.directory, options.excluded);
  const { sections, skipped } = readBuildSections(options, pages);
  const hashes = sections.map((section) => hash(judgedState(section)));
  const previous = readGraph(options.outPath);
  const judgments = reusableJudgments(previous);

  const pairs = countPairs(sections);
  const jobs = planRequests(sections, (from, to) =>
    judgments.has(pairKey(hashes[from]!, hashes[to]!)),
  );
  const toJudge = jobs.reduce((count, job) => count + job.targets.length, 0);
  const scorePlan = concepts && planScores(concepts, hashes, previous);
  checkJudgingAllowed(toJudge, scorePlan?.toScore ?? 0, options);

  const progress = await judgePairs({
    jobs,
    sections,
    hashes,
    judgments,
    client: options.client,
    previousModel: previous?.model ?? model,
  });
  const scores = await scoreConcepts({
    plan: scorePlan,
    judgingFailed: progress.failure !== undefined,
    sections,
    hashes,
    client: options.client,
  });

  const graphSections: Array<GraphSection> = sections.map((section, index) => ({
    id: section.id,
    page: section.page,
    pageTitle: section.pageTitle,
    heading: section.heading,
    hash: hashes[index]!,
  }));
  const edges = collectEdges(sections, hashes, judgments);
  writeGraph(options.outPath, {
    version: graphVersion,
    model: progress.model,
    questions: questionSetHash,
    relations,
    sections: graphSections,
    skipped,
    edges,
    links: rankLinks(graphSections, edges, options.scopes),
    ...scores.fields,
  });

  const failure = progress.failure ?? scores.progress.failure;
  if (failure !== undefined) {
    throwFailure({ failure, edges, pairs, scores, outPath: options.outPath });
  }
  return {
    pages: pages.length,
    sections: sections.length,
    skipped,
    pairs,
    reused: pairs - toJudge,
    judged: progress.judged,
    requests: progress.requests + scores.progress.requests,
    inputTokens: progress.inputTokens + scores.progress.inputTokens,
    scores: scores.report,
  };
}
