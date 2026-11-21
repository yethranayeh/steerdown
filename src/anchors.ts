/** The values of every `id` attribute in an HTML page */
export function getHtmlIdAttrs(html: string) {
  const ids = new Set<string>();

  for (const match of html.matchAll(/\sid\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    const value = match[1] ?? match[2] ?? "";
    ids.add(value.replace(/&amp;/g, "&"));
  }

  return ids;
}
