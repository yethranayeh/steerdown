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

/** From and to are indexes into `sections`. Probabilities follow the order of `relations`. */
export type Edge = [
  from: number,
  to: number,
  relation: string,
  probabilities: number[],
  confidence: number,
];

export type Graph = {
  version: number;
  model: string;
  /** Hash of the question set, so a changed question judges every pair again. */
  questions: string;
  relations: readonly string[];
  sections: GraphSection[];
  skipped: SkippedSection[];
  edges: Edge[];
};

/** Reads a graph file written by this version, or returns undefined when there is none to reuse. */
export function readGraph(path: string): Graph | undefined {
  if (!existsSync(path)) {
    return undefined;
  }
  const graph = JSON.parse(readFileSync(path, "utf8")) as Graph;
  return graph.version === graphVersion ? graph : undefined;
}

/** Writes one section, skipped section or edge per line, so changes show up as small diffs. */
export function writeGraph(path: string, graph: Graph): void {
  const list = (items: unknown[]) =>
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
    `  "edges": ${list(graph.edges)}`,
    "}",
    "",
  ].join("\n");
  writeFileSync(path, text);
}
