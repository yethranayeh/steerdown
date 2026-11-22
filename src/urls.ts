/** Where pages and their data files are served. Shared by emit and the browser script. */

/** The folder under the built site that holds one data file per page. */
export const emitFolder = "steerdown";

/** The URL a built HTML file is served at: `x/index.html` is `/x/`, `x.html` stays `/x.html`. */
export function pageUrl(htmlFile: string) {
  return `/${htmlFile.replace(/(^|\/)index\.html$/, "$1")}`;
}

/**
 * The built HTML files that can be served at a URL path, most likely first: `/x/` is
 * `x/index.html`, `/x.html` stays `x.html`, and `/x` is `x/index.html` or `x.html`, as static
 * hosts serve either at it.
 */
export function htmlFilesOf(urlPath: string) {
  const path = urlPath.replace(/^\/+/, "");
  if (path === "" || path.endsWith("/")) {
    return [`${path}index.html`];
  }

  return path.endsWith(".html") ? [path] : [`${path}/index.html`, `${path}.html`];
}

/** Where a page's data file goes: `x/index.html` gets `steerdown/x/index.json`, `x.html` gets `steerdown/x.json`. */
export function dataFilePath(htmlFile: string) {
  return `${emitFolder}/${htmlFile.replace(/\.html$/, ".json")}`;
}
