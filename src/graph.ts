import type { SkippedSection } from "./sections.ts";

import { existsSync, readFileSync, writeFileSync } from "node:fs";

export const graphVersion = 1;

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

export type Graph = {
  version: number;
  model: string;
  /** Hash of the question set, so a changed question judges every pair again. */
  questions: string;
  relations: ReadonlyArray<string>;
  sections: Array<GraphSection>;
  skipped: Array<SkippedSection>;
  edges: Array<Edge>;
  /** Each section's suggested links, in the order of `sections`. */
  links: Array<Array<Link>>;
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
 * Writes one section, skipped section, edge or section's links per line, so changes show up as
 * small diffs.
 */
export function writeGraph(path: string, graph: Graph) {
  const list = (items: Array<unknown>) =>
    items.length === 0
      ? "[]"
      : `[\n${items.map((item) => `    ${JSON.stringify(item)}`).join(",\n")}\n  ]`;
  const text = [
    "{",
    `  "version": ${graph.version},`,
    `  "model": ${JSON.stringify(graph.model)},`,
    `  "questions": ${JSON.stringify(graph.questions)},`,
    `  "relations": ${JSON.stringify(graph.relations)},`,
    `  "sections": ${list(graph.sections)},`,
    `  "skipped": ${list(graph.skipped)},`,
    `  "edges": ${list(graph.edges)},`,
    `  "links": ${list(graph.links)}`,
    "}",
    "",
  ].join("\n");
  writeFileSync(path, text);
}
