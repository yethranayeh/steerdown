import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import GithubSlugger from "github-slugger";

export type Section = {
  /** Page path, plus `#` and the heading slug for every section but the page intro. */
  id: string;
  page: string;
  pageTitle: string;
  /** Rendered heading text, empty for the page intro. */
  heading: string;
  text: string;
};

export type SkippedSection = { id: string; reason: string };

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

/** Lists the Markdown files under a directory as sorted paths relative to it, with forward slashes. */
export function findMarkdownFiles(directory: string, excluded: Array<string>): Array<string> {
  const pages = listFiles(directory).map((path) => relative(directory, path).split(sep).join("/"));
  return pages.filter((page) => page.endsWith(".md") && !isExcludedPage(page, excluded)).sort();
}

const frontMatterFence = /^---\s*$/;
const frontMatterEnd = /^(---|\.\.\.)\s*$/;
const frontMatterTitle = /^title:\s*(.*?)\s*$/;
const codeFenceOpening = /^ {0,3}(`{3,}|~{3,})/;
const atxHeading = /^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/;

/** The text a heading renders to: link targets, HTML tags and inline markers removed. */
export function renderedHeading(markdown: string): string {
  return markdown
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/!?\[([^\]]*)\]\[[^\]]*\]/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/`+([^`]*?)`+/g, "$1")
    .replace(/(\*\*|\*|~~)(.+?)\1/g, "$2")
    .replace(/(?<![\p{L}\p{N}])(__|_)(.+?)\1(?![\p{L}\p{N}])/gu, "$2")
    .replace(/\\([!-/:-@[-`{-~])/g, "$1")
    .trim();
}

/** Reads the title from leading front matter and returns where the page body starts. */
function readFrontMatter(lines: Array<string>): { title: string; bodyStart: number } {
  if (!frontMatterFence.test(lines[0] ?? "")) {
    return { title: "", bodyStart: 0 };
  }
  let title = "";
  const end = lines.findIndex((line, index) => index > 0 && frontMatterEnd.test(line));
  const frontMatter = end === -1 ? lines.slice(1) : lines.slice(1, end);
  for (const line of frontMatter) {
    const match = line.match(frontMatterTitle);
    if (match) {
      title = (match[1] ?? "").replace(/^(["'])(.*)\1$/, "$2");
    }
  }
  return { title, bodyStart: end === -1 ? lines.length : end + 1 };
}

/** An open code fence: its marker character and how many of them opened it. */
type Fence = { marker: string; length: number };

/** The lines under one `##` heading, or under none for the page intro. */
type Chunk = { heading: string; slug: string; lines: Array<string> };

/** True when a line closes the open fence: only the same marker, at least as many times. */
function closesFence(line: string, fence: string | undefined, open: Fence) {
  return (
    fence !== undefined &&
    fence[0] === open.marker &&
    fence.length >= open.length &&
    line.trim() === fence
  );
}

/**
 * Groups body lines under their `##` headings. The first `#` heading becomes the page title when
 * front matter gave none, and is left out of the text.
 */
function splitBody(
  lines: Array<string>,
  frontMatterTitle: string,
): { pageTitle: string; chunks: Array<Chunk> } {
  let pageTitle = frontMatterTitle;
  const slugger = new GithubSlugger();
  const chunks: Array<Chunk> = [{ heading: "", slug: "", lines: [] }];
  let openFence: Fence | undefined;

  for (const line of lines) {
    const current = chunks[chunks.length - 1]!;
    const fence = line.match(codeFenceOpening)?.[1];

    if (openFence !== undefined) {
      if (closesFence(line, fence, openFence)) {
        openFence = undefined;
      }
      current.lines.push(line);
      continue;
    }
    if (fence !== undefined) {
      openFence = { marker: fence[0]!, length: fence.length };
      current.lines.push(line);
      continue;
    }

    const heading = line.match(atxHeading);
    if (!heading) {
      current.lines.push(line);
      continue;
    }
    const level = heading[1]!.length;
    const text = renderedHeading(heading[2] ?? "");
    // Every heading takes a slug, so later duplicates get the suffix the rendered page gives them.
    const slug = slugger.slug(text);
    const isFirstTitle = level === 1 && pageTitle === "";
    if (isFirstTitle) {
      pageTitle = text;
      continue;
    }
    if (level === 2) {
      chunks.push({ heading: text, slug, lines: [] });
      continue;
    }
    current.lines.push(line);
  }
  return { pageTitle, chunks };
}

/**
 * Splits one Markdown page into sections at its `##` headings. Text before the first `##` is the
 * page intro. Heading slugs follow github-slugger over every heading level, so repeated headings
 * get the same `-1`, `-2` suffixes the rendered page gives them.
 *
 * A line scanner, not a full Markdown parser. It knows front matter, fenced code and `#` headings,
 * not setext headings. Switch to a parser when real documentation shows it splitting pages wrongly.
 */
export function splitPage(page: string, markdown: string): Array<Section> {
  const lines = markdown.split(/\r?\n/);
  const frontMatter = readFrontMatter(lines);
  const body = splitBody(lines.slice(frontMatter.bodyStart), frontMatter.title);
  const pageTitle = body.pageTitle || page.replace(/\.md$/, "");

  const sections: Array<Section> = [];
  for (const chunk of body.chunks) {
    const text = chunk.lines.join("\n").trim();
    const isPageIntro = chunk.heading === "";
    if (isPageIntro && text === "") {
      continue;
    }
    sections.push({
      id: isPageIntro ? page : `${page}#${chunk.slug}`,
      page,
      pageTitle,
      heading: chunk.heading,
      text,
    });
  }
  return sections;
}

const linkListShareForHub = 0.6;
const minimumLinksForHub = 3;
const linkListItem = /^(?:[-*+]|\d+[.)])\s+\[[^\]]+\]\([^)]*\)/;
const lineThatIsOnlyALink = /^\[[^\]]+\]\([^)]*\)$/;

/** True when a section is mainly a list of links to other pages, such as a table of contents. */
export function isLinkHub(text: string): boolean {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) {
    return false;
  }
  const linkLines = lines.filter(
    (line) => linkListItem.test(line) || lineThatIsOnlyALink.test(line),
  );
  const linkCount = text.match(/\]\(/g)?.length ?? 0;
  return linkLines.length / lines.length >= linkListShareForHub && linkCount >= minimumLinksForHub;
}

/** Reads and splits every page, leaving out link hubs. */
export function readSections(
  directory: string,
  pages: Array<string>,
): { sections: Array<Section>; skipped: Array<SkippedSection> } {
  const sections: Array<Section> = [];
  const skipped: Array<SkippedSection> = [];
  for (const page of pages) {
    for (const section of splitPage(page, readFileSync(join(directory, page), "utf8"))) {
      if (isLinkHub(section.text)) {
        skipped.push({ id: section.id, reason: "mainly a list of links" });
        continue;
      }
      sections.push(section);
    }
  }
  return { sections, skipped };
}
