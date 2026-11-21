import type { Graph, GraphSection } from "./graph.ts";

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getHtmlIdAttrs } from "./anchors.ts";
import { ReportedError } from "./errors.ts";
import { readGraph } from "./graph.ts";
import { candidatesBySection } from "./rank.ts";
import { coveredScore } from "./scores.ts";

/** The folder under the built site that holds one data file per page. */
export const emitFolder = "steerdown";

/** A concept index into the file's `concepts` and its score, from "Covers part of it" up. */
type ConceptScore = [concept: number, score: number];

/**
 * A showable link. Target is an index into the file's `targets`. The origin sentence's position
 *  and hash follow when the graph has them.
 */
type LinkRow =
  | [target: number, relation: string, probability: number]
  | [target: number, relation: string, probability: number, sentence: number, sentenceHash: string];

type PageSection = {
  id: string;
  links: Array<LinkRow>;
  /** The build's default links, as indexes into `links`, in their order. */
  defaults: Array<number>;
  /** Present when the graph has concepts. */
  scores?: Array<ConceptScore>;
};

/** A link target. Its concept scores follow when the graph has concepts. */
type TargetRow =
  | [url: string, pageTitle: string, heading: string]
  | [url: string, pageTitle: string, heading: string, scores: Array<ConceptScore>];

/** What a page's browser script reads to show its suggested links. */
export type PageFile = {
  sections: Array<PageSection>;
  targets: Array<TargetRow>;
  /** The concepts the file's scores refer to, as id and label. Present when the graph has concepts. */
  concepts?: Array<[id: string, label: string]>;
};

/** A graph page's built HTML: its URL, the ids it holds and where its data file goes. */
type BuiltPage = { url: string; ids: Set<string>; dataFile: string };

export type LeftOutPage = { page: string; reason: string };

export type EmitReport = {
  written: number;
  bytes: number;
  leftOut: Array<LeftOutPage>;
  /** Links dropped because their target's page has no built HTML. */
  linksWithoutPage: number;
  /** Links dropped because their target's heading has no matching id in the built HTML. */
  linksWithoutId: number;
};

/** The URL a built HTML file is served at: `x/index.html` is `/x/`, `x.html` stays `/x.html`. */
export function pageUrl(htmlFile: string) {
  return `/${htmlFile.replace(/(^|\/)index\.html$/, "$1")}`;
}

/** Where a page's data file goes: `x/index.html` gets `steerdown/x/index.json`, `x.html` gets `steerdown/x.json`. */
export function dataFilePath(htmlFile: string) {
  return `${emitFolder}/${htmlFile.replace(/\.html$/, ".json")}`;
}

/** Reads a graph page's built HTML, or returns undefined when the site no longer has it. */
function readBuiltPage(htmlDirectory: string, page: string): BuiltPage | undefined {
  const htmlPath = join(htmlDirectory, page);
  if (!existsSync(htmlPath)) {
    return undefined;
  }

  return {
    url: pageUrl(page),
    ids: getHtmlIdAttrs(readFileSync(htmlPath, "utf8")),
    dataFile: dataFilePath(page),
  };
}

/** The heading id after the `#` in a section id, or undefined for a page's intro. */
function headingId(section: GraphSection) {
  return section.id === section.page ? undefined : section.id.slice(`${section.page}#`.length);
}

/** Each section's scores from "Covers part of it" up, or undefined when the graph has no concepts. */
function coveredScoresBySection(graph: Graph) {
  if (graph.concepts === undefined || graph.scores === undefined) {
    return undefined;
  }

  const bySection: Array<Array<ConceptScore>> = graph.sections.map(() => []);
  for (const [section, concept, score] of graph.scores) {
    if (score >= coveredScore) {
      bySection[section]!.push([concept, score]);
    }
  }
  return bySection;
}

/** What every page file is built from. */
type EmitContext = {
  graph: Graph;
  builtPages: Map<string, BuiltPage | undefined>;
  candidates: ReturnType<typeof candidatesBySection>;
  /** Origin sentence position and hash, keyed by `from>to`. */
  origins: Map<string, [sentence: number, sentenceHash: string]>;
  scores: Array<Array<ConceptScore>> | undefined;
  report: EmitReport;
};

/** Builds one page's file, adding targets and concepts as its links and scores refer to them. */
class PageFileBuilder {
  readonly file: PageFile = { sections: [], targets: [] };
  private readonly targetIndexes = new Map<number, number>();
  private readonly conceptIndexes = new Map<number, number>();

  constructor(private readonly context: EmitContext) {
    if (context.scores !== undefined) {
      this.file.concepts = [];
    }
  }

  /** The section's scores with concept indexes into this file, or undefined without concepts. */
  private scoresOf(section: number) {
    const scores = this.context.scores?.[section];
    if (scores === undefined) {
      return undefined;
    }
    return scores.map(([concept, score]): ConceptScore => [this.conceptIndex(concept), score]);
  }

  private conceptIndex(concept: number) {
    let index = this.conceptIndexes.get(concept);
    if (index === undefined) {
      const { id, label } = this.context.graph.concepts![concept]!;
      index = this.file.concepts!.push([id, label]) - 1;
      this.conceptIndexes.set(concept, index);
    }
    return index;
  }

  /** The target's index in this file, or undefined when its built HTML gives it no anchor. */
  private targetIndex(to: number) {
    const known = this.targetIndexes.get(to);
    if (known !== undefined) {
      return known;
    }

    const section = this.context.graph.sections[to]!;
    const built = this.context.builtPages.get(section.page);
    const anchor = headingId(section);
    if (built === undefined) {
      this.context.report.linksWithoutPage++;
      return undefined;
    }
    if (anchor !== undefined && !built.ids.has(anchor)) {
      this.context.report.linksWithoutId++;
      return undefined;
    }

    const url = anchor === undefined ? built.url : `${built.url}#${anchor}`;
    const row: TargetRow = [url, section.pageTitle, section.heading];
    const scores = this.scoresOf(to);
    const index = this.file.targets.push(scores === undefined ? row : [...row, scores]) - 1;
    this.targetIndexes.set(to, index);
    return index;
  }

  /** Adds a section with its showable links whose targets the built HTML has. */
  addSection(from: number) {
    const links: Array<LinkRow> = [];
    const linkIndexByTarget = new Map<number, number>();

    for (const { to, relation, probability } of this.context.candidates[from]!) {
      const target = this.targetIndex(to);
      if (target === undefined) {
        continue;
      }
      const origin = this.context.origins.get(`${from}>${to}`);
      linkIndexByTarget.set(to, links.length);
      links.push(
        origin === undefined
          ? [target, relation, probability]
          : [target, relation, probability, ...origin],
      );
    }

    const defaults = (this.context.graph.links[from] ?? [])
      .map(([to]) => linkIndexByTarget.get(to))
      .filter((index) => index !== undefined);
    const section: PageSection = { id: this.context.graph.sections[from]!.id, links, defaults };
    const scores = this.scoresOf(from);
    if (scores !== undefined) {
      section.scores = scores;
    }
    this.file.sections.push(section);
  }
}

/** The graph's sections grouped by page, each in graph order. */
function sectionsByPage(sections: Array<GraphSection>) {
  const pages = new Map<string, Array<number>>();
  sections.forEach((section, index) => {
    const list = pages.get(section.page) ?? [];
    list.push(index);
    pages.set(section.page, list);
  });
  return pages;
}

/**
 * Writes one data file per graph page that has built HTML, under the `steerdown` folder of the
 *  built site. Each holds the page's sections with their showable links, the build's default
 *  links, every target's URL, title and heading and, with concepts, the scores that pin links.
 */
export function emit({
  graphPath,
  htmlDirectory,
}: {
  graphPath: string;
  htmlDirectory: string;
}): EmitReport {
  const graph = readGraph(graphPath);
  if (graph === undefined) {
    throw new ReportedError(`no graph file at ${graphPath}. Run steerdown build first.`);
  }

  const pages = sectionsByPage(graph.sections);
  const report: EmitReport = {
    written: 0,
    bytes: 0,
    leftOut: [],
    linksWithoutPage: 0,
    linksWithoutId: 0,
  };
  const context: EmitContext = {
    graph,
    builtPages: new Map(
      [...pages.keys()].map((page) => [page, readBuiltPage(htmlDirectory, page)]),
    ),
    candidates: candidatesBySection(graph.sections, graph.edges, graph.scopes ?? []),
    origins: new Map(
      (graph.origins ?? []).map(([from, to, sentence, sentenceHash]) => [
        `${from}>${to}`,
        [sentence, sentenceHash],
      ]),
    ),
    scores: coveredScoresBySection(graph),
    report,
  };

  for (const [page, sections] of pages) {
    const built = context.builtPages.get(page);
    if (built === undefined) {
      report.leftOut.push({ page, reason: "no built HTML page" });
      continue;
    }

    const builder = new PageFileBuilder(context);
    for (const section of sections) {
      builder.addSection(section);
    }
    const text = JSON.stringify(builder.file);
    const path = join(htmlDirectory, built.dataFile);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
    report.written++;
    report.bytes += Buffer.byteLength(text);
  }

  return report;
}
