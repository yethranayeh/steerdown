/** Where pages and their data files are served. Shared by emit and the browser script. */

/** The folder under the built site that holds one data file per page. */
export const emitFolder = "steerdown";

/** The URL a built HTML file is served at: `x/index.html` is `/x/`, `x.html` stays `/x.html`. */
export function pageUrl(htmlFile: string) {
  return `/${htmlFile.replace(/(^|\/)index\.html$/, "$1")}`;
}

/** The built HTML file served at a URL path: `/x/` is `x/index.html`, `/x.html` stays `x.html`. */
export function htmlFileOf(urlPath: string) {
  const path = urlPath.replace(/^\/+/, "");
  return path === "" || path.endsWith("/") ? `${path}index.html` : path;
}

/** Where a page's data file goes: `x/index.html` gets `steerdown/x/index.json`, `x.html` gets `steerdown/x.json`. */
export function dataFilePath(htmlFile: string) {
  return `${emitFolder}/${htmlFile.replace(/\.html$/, ".json")}`;
}
