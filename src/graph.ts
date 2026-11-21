import type { SkippedSection } from "./sections.ts";

import { existsSync, readFileSync, writeFileSync } from "node:fs";

export const graphVersion = 2;

export const relations = [
  "prerequisite",
  "next_step",
  "detail",
  "alternative",
  "unrelated",
] as const;

export type GraphSection = {
  id: string;
  page: string;
  pageTitle: string;
  heading: string;
  /** Hash of the text the judge read, so a rebuild can tell which sections changed. */
  hash: string;
};

/**
 * From and to are indexes into `sections`.
 * Probabilities follow the order of `relations`.
 */
export type Edge = [
  from: number,
  to: number,
  relation: string,
  probabilities: Array<number>,
  confidence: number,
];

/** A suggested link: the target's index into `sections` and its relation. */
export type Link = [to: number, relation: string];

export type GraphConcept = {
  id: string;
  label: string;
  /** Hash of the label and definition Jev read, so a rebuild can tell which concepts changed. */
  hash: string;
};

/**
 * Section is an index into `sections`, concept an index into `concepts`.
 * Score runs from 0 to 3, one step per level of the score question.
 */
export type Score = [section: number, concept: number, score: number, confidence: number];

/**
 * The sentence a shown link grows out of. From and to are indexes into `sections`,
 *  sentence is its position in the source section's sentences, sentenceHash the hash of its
 *  letters and digits, and similarity is the cosine of their embeddings
 */
export type Origin = [
  from: number,
  to: number,
  sentence: number,
  sentenceHash: string,
  similarity: number,
];

export type Graph = {
  version: number;
  model: string;
  /** Hash of the question set, so a changed question judges every pair again. */
  questions: string;
  relations: ReadonlyArray<string>;
  /** The build's scope paths, present when it had any. Sections in two scopes link only as alternatives. */
  scopes?: Array<string>;
  sections: Array<GraphSection>;
  skipped: Array<SkippedSection>;
  edges: Array<Edge>;
  /** Each section's suggested links, in the order of `sections`. */
  links: Array<Array<Link>>;
  /** Hash of the score question, so a changed question scores every section again. */
  scoreQuestion?: string;
  /** The concepts from the concept file, present when the build read one. */
  concepts?: Array<GraphConcept>;
  scores?: Array<Score>;
  /** The embedding model that found `origins`, present when the build had one. */
  embeddingModel?: string;
  origins?: Array<Origin>;
};

/** Reads a graph file written by this version, or returns undefined when there is none to reuse. */
export function readGraph(path: string) {
  if (!existsSync(path)) {
    return undefined;
  }

  const graph = JSON.parse(readFileSync(path, "utf8")) as Graph;
  return graph.version === graphVersion ? graph : undefined;
}

/**
 * Writes one section, skipped section, edge, section's links, concept,
 *  score or origin per line, so changes show up as small diffs.
 */
export function writeGraph(path: string, graph: Graph) {
  const list = (items: Array<unknown>) =>
    items.length === 0
      ? "[]"
      : `[\n${items.map((item) => `    ${JSON.stringify(item)}`).join(",\n")}\n  ]`;
  const hasScopes = graph.scopes !== undefined && graph.scopes.length > 0;
  const fields = [
    `  "version": ${graph.version}`,
    `  "model": ${JSON.stringify(graph.model)}`,
    `  "questions": ${JSON.stringify(graph.questions)}`,
    `  "relations": ${JSON.stringify(graph.relations)}`,
    ...(hasScopes ? [`  "scopes": ${JSON.stringify(graph.scopes)}`] : []),
    `  "sections": ${list(graph.sections)}`,
    `  "skipped": ${list(graph.skipped)}`,
    `  "edges": ${list(graph.edges)}`,
    `  "links": ${list(graph.links)}`,
  ];

  if (graph.concepts !== undefined && graph.scores !== undefined) {
    fields.push(
      `  "scoreQuestion": ${JSON.stringify(graph.scoreQuestion)}`,
      `  "concepts": ${list(graph.concepts)}`,
      `  "scores": ${list(graph.scores)}`,
    );
  }

  if (graph.embeddingModel !== undefined && graph.origins !== undefined) {
    fields.push(
      `  "embeddingModel": ${JSON.stringify(graph.embeddingModel)}`,
      `  "origins": ${list(graph.origins)}`,
    );
  }

  writeFileSync(path, `{\n${fields.join(",\n")}\n}\n`);
}
