import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Finds the built HTML page for a Markdown page: `guide.md` is `guide/index.html` or
 *  `guide.html`, and `index.md` is the `index.html` beside it
 */
export function findHtmlPage(htmlDirectory: string, page: string) {
  const withoutExtension = page.replace(/\.md$/, "");
  const candidates = [join(withoutExtension, "index.html"), `${withoutExtension}.html`];

  return candidates.map((path) => join(htmlDirectory, path)).find((path) => existsSync(path));
}

/** The values of every `id` attribute in an HTML page */
export function getHtmlIdAttrs(html: string) {
  const ids = new Set<string>();

  for (const match of html.matchAll(/\sid\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    const value = match[1] ?? match[2] ?? "";
    ids.add(value.replace(/&amp;/g, "&"));
  }

  return ids;
}

/** Reads the ids of a page's built HTML, or returns undefined when the page has no HTML file */
export function readPageIds(htmlDirectory: string, page: string) {
  const htmlPath = findHtmlPage(htmlDirectory, page);
  if (htmlPath === undefined) {
    return undefined;
  }

  return getHtmlIdAttrs(readFileSync(htmlPath, "utf8"));
}
