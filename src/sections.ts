import type { DefaultTreeAdapterTypes } from "parse5";
import type { Block, NodeAdapter } from "./split.ts";

import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { parse } from "parse5";
import {
  documentTitle,
  firstElement,
  isLinkHub,
  judgedText,
  pagefindBodies,
  splitContent,
} from "./split.ts";

export type Section = {
  /** Page path, plus `#` and the section's id for every section but the page intro. */
  id: string;
  /** Path of the built HTML file, relative to the site. */
  page: string;
  pageTitle: string;
  /** Heading text, empty for the page intro. */
  heading: string;
  blocks: Array<Block>;
  /** The section's judged text, a line per block. */
  text: string;
};

export type SkippedSection = { id: string; reason: string };

/** An `h2` with no id, whose text stays in the section before it. */
export type IdlessHeading = { page: string; heading: string };

type ParsedNode = DefaultTreeAdapterTypes.Node;

const parse5Adapter: NodeAdapter<ParsedNode> = {
  name: (node) => ("tagName" in node ? node.tagName : undefined),
  attribute: (node, name) =>
    "attrs" in node
      ? node.attrs.find((attribute) => attribute.name === name && !attribute.namespace)?.value
      : undefined,
  children: (node) => ("childNodes" in node ? node.childNodes : []),
  text: (node) =>
    node.nodeName === "#text" ? (node as DefaultTreeAdapterTypes.TextNode).value : undefined,
};

const ignoredDirectoryNames = new Set(["node_modules"]);

/** Every file under a directory, leaving out hidden entries and dependency folders. */
function listFiles(directory: string): Array<string> {
  const files: Array<string> = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const isIgnored = entry.name.startsWith(".") || ignoredDirectoryNames.has(entry.name);
    if (isIgnored) {
      continue;
    }
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      for (const file of listFiles(path)) {
        files.push(file);
      }
    } else if (entry.isFile()) {
      files.push(path);
    }
  }
  return files;
}

/** True when a page is an excluded file or lies inside an excluded folder. */
function isExcludedPage(page: string, excluded: Array<string>) {
  const excludedPaths = excluded.map((path) => path.replace(/\/+$/, ""));
  return excludedPaths.some((path) => page === path || page.startsWith(`${path}/`));
}

/** Lists the HTML pages of a built site as sorted paths relative to it, with forward slashes. */
export function findHtmlPages(directory: string, excluded: Array<string>): Array<string> {
  const pages = listFiles(directory).map((path) => relative(directory, path).split(sep).join("/"));
  return pages.filter((page) => page.endsWith(".html") && !isExcludedPage(page, excluded)).sort();
}

type ParsedPage = { page: string; document: ParsedNode; bodies: Array<ParsedNode> };

/**
 * The elements that hold a page's content: its `data-pagefind-body` elements when the site marks
 * any, otherwise `main`, then `body`.
 */
function contentRoots(parsed: ParsedPage, siteMarksBodies: boolean): Array<ParsedNode> {
  if (siteMarksBodies) {
    return parsed.bodies;
  }
  const root =
    firstElement(parsed.document, parse5Adapter, "main") ??
    firstElement(parsed.document, parse5Adapter, "body");
  return root === undefined ? [] : [root];
}

type ReadResult = {
  sections: Array<Section>;
  skipped: Array<SkippedSection>;
  idlessHeadings: Array<IdlessHeading>;
};

/** Splits one parsed page into sections, leaving out link hubs. */
function readPage(parsed: ParsedPage, roots: Array<ParsedNode>, result: ReadResult) {
  const { page, document } = parsed;
  const split = splitContent(roots, parse5Adapter);
  const pageTitle = split.title || documentTitle(document, parse5Adapter) || page;
  for (const heading of split.idlessHeadings) {
    result.idlessHeadings.push({ page, heading });
  }
  for (const { anchor, heading, blocks } of split.sections) {
    const id = anchor === "" ? page : `${page}#${anchor}`;
    if (isLinkHub(blocks)) {
      result.skipped.push({ id, reason: "mainly a list of links" });
      continue;
    }
    result.sections.push({ id, page, pageTitle, heading, blocks, text: judgedText(blocks) });
  }
}

/**
 * Reads and splits every page, leaving out link hubs. When any page marks `data-pagefind-body`,
 * pages without it are left out.
 */
export function readSections(directory: string, pages: Array<string>): ReadResult {
  const parsedPages: Array<ParsedPage> = pages.map((page) => {
    const document = parse(readFileSync(join(directory, page), "utf8"));
    return { page, document, bodies: pagefindBodies(document, parse5Adapter) };
  });
  const siteMarksBodies = parsedPages.some((parsed) => parsed.bodies.length > 0);
  const result: ReadResult = { sections: [], skipped: [], idlessHeadings: [] };
  for (const parsed of parsedPages) {
    const roots = contentRoots(parsed, siteMarksBodies);
    if (roots.length === 0) {
      result.skipped.push({ id: parsed.page, reason: "no data-pagefind-body element" });
      continue;
    }
    readPage(parsed, roots, result);
  }
  return result;
}
