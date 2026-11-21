import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ReportedError } from "./errors.ts";
import { readGraph } from "./graph.ts";
import {
  conceptHash,
  coveredCounts,
  mentionedScore,
  overBroadConcepts,
  uncoveredSections,
} from "./scores.ts";

/** A concept as the concept file and the proposal file hold it. */
export type Concept = { id: string; label: string; definition: string };

const conceptFields: ReadonlyArray<string> = ["id", "label", "definition"];
/** Lowercase letters and digits, in words joined by single hyphens. */
const conceptIdPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const sentenceSegmenter = new Intl.Segmenter("en", { granularity: "sentence" });

/** The hand-edited concept file, next to the graph file. */
export function conceptFilePath(graphPath: string) {
  return join(dirname(graphPath), "steerdown.concepts.json");
}

/** The file proposed concepts wait in until a person moves them into the concept file. */
export function proposalFilePath(graphPath: string) {
  return join(dirname(graphPath), "steerdown.proposals.json");
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new ReportedError(`cannot read ${path}: ${(error as Error).message}`);
  }
}

function sentenceCount(text: string) {
  const sentences = [...sentenceSegmenter.segment(text)];
  return sentences.filter(({ segment }) => segment.trim() !== "").length;
}

/** Missing, empty and unknown fields of one concept. */
function fieldProblems(fields: Record<string, unknown>): Array<string> {
  const problems: Array<string> = [];
  for (const field of conceptFields) {
    const value = fields[field];
    if (typeof value !== "string" || value.trim() === "") {
      problems.push(`needs a non-empty string "${field}"`);
    }
  }

  for (const field of Object.keys(fields)) {
    if (!conceptFields.includes(field)) {
      problems.push(`has an unknown field "${field}"`);
    }
  }
  return problems;
}

/** What is wrong with one concept on its own, ignoring the other concepts. */
function itemProblems(item: unknown): Array<string> {
  const isObject = typeof item === "object" && item !== null && !Array.isArray(item);
  if (!isObject) {
    return ["is not an object"];
  }

  const problems = fieldProblems(item as Record<string, unknown>);
  if (problems.length > 0) {
    return problems;
  }

  const concept = item as Concept;
  if (!conceptIdPattern.test(concept.id)) {
    problems.push(`has the id "${concept.id}", which is not lowercase words joined by hyphens`);
  }

  const sentences = sentenceCount(concept.definition);
  if (sentences !== 1) {
    problems.push(`has a definition of ${sentences} sentences instead of one`);
  }

  return problems;
}

/**
 * Everything wrong with a list of concepts. `takenIds` maps ids the list must not reuse to where
 * they are already used.
 */
function conceptProblems(value: unknown, takenIds: Map<string, string>, itemName: string) {
  if (!Array.isArray(value)) {
    return ["is not a JSON array of concepts"];
  }

  const problems: Array<string> = [];
  const usedIds = new Map(takenIds);
  value.forEach((item: unknown, index) => {
    const name = `${itemName} ${index + 1}`;
    for (const problem of itemProblems(item)) {
      problems.push(`${name} ${problem}`);
    }

    const id = (item as Partial<Concept> | null)?.id;
    if (typeof id !== "string") {
      return;
    }

    const usedBy = usedIds.get(id);
    if (usedBy === undefined) {
      usedIds.set(id, `${itemName} ${index + 1}`);
    } else {
      problems.push(`${name} has the id "${id}", already used by ${usedBy}`);
    }
  });

  return problems;
}

/** Reads a list of concepts, or throws an error naming every problem in it. */
function readConceptList(path: string, takenIds: Map<string, string>, itemName: string) {
  const value = readJson(path);
  const problems = conceptProblems(value, takenIds, itemName);
  if (problems.length > 0) {
    throw new ReportedError(`${path} has problems:\n  ${problems.join("\n  ")}`);
  }

  return value as Array<Concept>;
}

/** Reads the concept file, or returns undefined when there is none. */
export function readConceptFile(path: string): Array<Concept> | undefined {
  return existsSync(path) ? readConceptList(path, new Map(), "concept") : undefined;
}

/** The concept file's concepts and the proposals waiting for review, empty when a file is absent. */
function readConceptsAndProposals(graphPath: string) {
  const conceptPath = conceptFilePath(graphPath);
  const proposalPath = proposalFilePath(graphPath);
  const concepts = readConceptFile(conceptPath) ?? [];
  const proposed = existsSync(proposalPath)
    ? readConceptList(proposalPath, new Map(), "proposal")
    : [];
  return { conceptPath, proposalPath, concepts, proposed };
}

/**
 * Checks proposed concepts and adds them to the proposal file. Nothing is written when any
 * proposal has a problem.
 */
export function proposeConcepts(graphPath: string, proposalsPath: string) {
  const { conceptPath, proposalPath, concepts, proposed } = readConceptsAndProposals(graphPath);
  const takenIds = new Map<string, string>();
  for (const concept of concepts) {
    takenIds.set(concept.id, conceptPath);
  }

  for (const concept of proposed) {
    takenIds.set(concept.id, proposalPath);
  }

  const added = readConceptList(proposalsPath, takenIds, "proposal");
  writeFileSync(proposalPath, `${JSON.stringify([...proposed, ...added], null, 2)}\n`);
  return { added: added.length, proposalPath };
}

/**
 * What an agent needs to propose concepts: the graph's sections with the scores that at least
 * mention a concept, the concepts and proposals so far, the sections no concept covers well and
 * the over-broad concepts.
 */
export function conceptInput(graphPath: string) {
  const graph = readGraph(graphPath);
  if (graph === undefined) {
    throw new ReportedError(`no graph file at ${graphPath}. Run steerdown build first.`);
  }

  const { conceptPath, proposalPath, concepts, proposed } = readConceptsAndProposals(graphPath);
  const scoredConcepts = graph.concepts ?? [];
  const scores = graph.scores ?? [];

  const sections = graph.sections.map((section) => ({
    id: section.id,
    page: section.page,
    pageTitle: section.pageTitle,
    heading: section.heading,
    scores: {} as Record<string, number>,
  }));

  for (const [section, concept, score] of scores) {
    if (score >= mentionedScore) {
      sections[section]!.scores[scoredConcepts[concept]!.id] = score;
    }
  }

  const counts = coveredCounts(scoredConcepts, scores);
  const countsByHash = new Map(
    scoredConcepts.map((concept, index) => [concept.hash, counts[index]]),
  );

  return {
    conceptFile: conceptPath,
    proposalFile: proposalPath,
    sections,
    concepts: concepts.map((concept) => ({
      ...concept,
      coveredSections: countsByHash.get(conceptHash(concept)) ?? null,
    })),
    proposed,
    uncovered: uncoveredSections(sections.length, scores).map((index) => sections[index]!.id),
    overBroad: overBroadConcepts(sections.length, scoredConcepts, scores),
  };
}
