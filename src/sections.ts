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

/** Lists the Markdown files under a directory as sorted paths relative to it, with forward slashes. */
export function findMarkdownFiles(directory: string, excluded: string[]): string[] {
  const excludedPaths = excluded.map((path) => path.replace(/\/+$/, ""));
  const isExcluded = (page: string) =>
    excludedPaths.some((path) => page === path || page.startsWith(`${path}/`));
  const pages: string[] = [];
  const visit = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const isHidden = entry.name.startsWith(".");
      if (isHidden || ignoredDirectoryNames.has(entry.name)) {
        continue;
      }
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        visit(path);
        continue;
      }
      const page = relative(directory, path).split(sep).join("/");
      if (entry.isFile() && page.endsWith(".md") && !isExcluded(page)) {
        pages.push(page);
      }
    }
  };
  visit(directory);
  return pages.sort();
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

/**
 * Splits one Markdown page into sections at its `##` headings. Text before the first `##` is the
 * page intro. Heading slugs follow github-slugger over every heading level, so repeated headings
 * get the same `-1`, `-2` suffixes the rendered page gives them.
 *
 * A line scanner, not a full Markdown parser. It knows front matter, fenced code and `#` headings,
 * not setext headings. Switch to a parser when real documentation shows it splitting pages wrongly.
 */
export function splitPage(page: string, markdown: string): Section[] {
  const lines = markdown.split(/\r?\n/);
  let pageTitle = "";
  let lineIndex = 0;

  if (frontMatterFence.test(lines[0] ?? "")) {
    for (lineIndex = 1; lineIndex < lines.length; lineIndex++) {
      const line = lines[lineIndex] ?? "";
      if (frontMatterEnd.test(line)) {
        lineIndex++;
        break;
      }
      const title = line.match(frontMatterTitle);
      if (title) {
        pageTitle = (title[1] ?? "").replace(/^(["'])(.*)\1$/, "$2");
      }
    }
  }

  const slugger = new GithubSlugger();
  const chunks: { heading: string; slug: string; lines: string[] }[] = [
    { heading: "", slug: "", lines: [] },
  ];
  let openFence: { marker: string; length: number } | undefined;

  for (; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex] ?? "";
    const current = chunks[chunks.length - 1]!;
    const fence = line.match(codeFenceOpening)?.[1];

    if (openFence) {
      const closesFence =
        fence !== undefined &&
        fence[0] === openFence.marker &&
        fence.length >= openFence.length &&
        line.trim() === fence;
      if (closesFence) {
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

  const title = pageTitle || page.replace(/\.md$/, "");
  const sections: Section[] = [];
  for (const chunk of chunks) {
    const text = chunk.lines.join("\n").trim();
    const isEmptyIntro = chunk.heading === "" && text === "";
    if (isEmptyIntro) {
      continue;
    }
    sections.push({
      id: chunk.heading === "" ? page : `${page}#${chunk.slug}`,
      page,
      pageTitle: title,
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
  pages: string[],
): { sections: Section[]; skipped: SkippedSection[] } {
  const sections: Section[] = [];
  const skipped: SkippedSection[] = [];
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
