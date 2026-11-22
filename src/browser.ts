/**
 * The browser API: a page's suggested links and the sentence each one grows out of. It draws
 * nothing. The site renders the links and any highlight. Bundled on its own for the browser, so
 * keep it free of Node imports.
 */
import type { PageFile } from "./emit.ts";
import type { NodeAdapter } from "./split.ts";

import { pickLinks } from "./pick.ts";
import { sentenceKey, splitSentences } from "./sentences.ts";
import { firstElement, pagefindBodies, splitContent } from "./split.ts";
import { dataFilePath, htmlFilesOf } from "./urls.ts";

type DomNode = {
  nodeType: number;
  localName?: string;
  data?: string;
  childNodes: Iterable<DomNode>;
  getAttribute?: (name: string) => string | null;
};

type DomRange = {
  setStart: (node: DomNode, offset: number) => void;
  setEnd: (node: DomNode, offset: number) => void;
};

type DomDocument = DomNode & { createRange: () => DomRange };

/**
 * A DOM Range. It is the DOM's own `Range` type wherever the site's types include the DOM, so a
 * site can pass it to `new Highlight()` without a cast.
 */
export type BrowserRange = typeof globalThis extends { Range: { prototype: infer DomLibRange } }
  ? DomLibRange
  : DomRange;

type BrowserGlobals = {
  document: DomDocument;
  location: { pathname: string };
  localStorage: {
    getItem: (key: string) => string | null;
    setItem: (key: string, value: string) => void;
  };
};

const elementNode = 1;
const textNode = 3;
/** The build keeps this many hex digits of a SHA-256 digest. */
const hashLength = 16;
const pinsKey = "steerdown:pins";

const domAdapter: NodeAdapter<DomNode> = {
  name: (node) => (node.nodeType === elementNode ? node.localName : undefined),
  attribute: (node, name) => node.getAttribute?.(name) ?? undefined,
  children: (node) => node.childNodes,
  text: (node) => (node.nodeType === textNode ? node.data : undefined),
};

function browser() {
  return globalThis as unknown as BrowserGlobals;
}

export type SuggestedLink = {
  url: string;
  pageTitle: string;
  heading: string;
  relation: string;
  probability: number;
  /** The origin sentence's position in the section and the hash of its letters and digits. */
  origin?: { position: number; hash: string };
};

export type Concept = { id: string; label: string };

/** A sentence of the page, split as the build splits it. */
export type PageSentence = {
  /** The id of its section, empty for the page intro. */
  anchor: string;
  /** Its position in the section, as a link's origin counts it. */
  position: number;
  /** The hash of its letters and digits, as a link's origin stores it. */
  hash: string;
  /** From its first letter or digit to its last. */
  range: BrowserRange;
};

/** A ranked link and the sentence it grows out of. */
export type RankedLink = SuggestedLink & { sentence: PageSentence };

export type SteerdownPage = {
  /** The concepts a reader can pin, empty when the site has no concept file. */
  concepts: Array<Concept>;
  /**
   * A section's three links. The anchor is the section's id, empty for the page intro. Pinned
   * concept ids put the targets that cover them first.
   */
  links: (anchor: string, pins?: Array<string>) => Array<SuggestedLink>;
  /** Every judged link of a section, most probable first. */
  allLinks: (anchor: string) => Array<SuggestedLink>;
  /**
   * The links that grow out of the sentences a reader is on, at most three, best first. Each
   * link scores its probability times its origin sentence's weight. Sentences weighted 0 or less
   * add no links, so the result is empty when the reader is on none that has one. The variety
   * rules of the default links apply. `sentences` is the page's, from `readSentences()`.
   */
  rank: (
    sentences: Array<PageSentence>,
    weight: (sentence: PageSentence) => number,
  ) => Array<RankedLink>;
};

type PageSection = PageFile["sections"][number];
type LinkRow = PageSection["links"][number];

/** The id after the `#` in a section id, empty for a page intro. */
function anchorOf(sectionId: string) {
  const hashAt = sectionId.indexOf("#");
  return hashAt === -1 ? "" : sectionId.slice(hashAt + 1);
}

/** The sentence a link's origin names: the one with its hash nearest to its stored position. */
function nearestSentence(
  sentences: Array<PageSentence>,
  origin: { position: number; hash: string },
) {
  let found: PageSentence | undefined;
  for (const sentence of sentences) {
    const distance = Math.abs(sentence.position - origin.position);
    const isCloser = found === undefined || distance < Math.abs(found.position - origin.position);
    if (sentence.hash === origin.hash && isCloser) {
      found = sentence;
    }
  }
  return found;
}

/** The sentences grouped by section anchor. */
function sentencesByAnchor(sentences: Array<PageSentence>) {
  const byAnchor = new Map<string, Array<PageSentence>>();
  for (const sentence of sentences) {
    const group = byAnchor.get(sentence.anchor) ?? [];
    group.push(sentence);
    byAnchor.set(sentence.anchor, group);
  }
  return byAnchor;
}

/** Reads a page's data file as the API. */
export function pageFromData(file: PageFile): SteerdownPage {
  const sections = new Map(file.sections.map((section) => [anchorOf(section.id), section]));
  const concepts = (file.concepts ?? []).map(([id, label]) => ({ id, label }));

  const suggested = ([target, relation, probability, position, hash]: LinkRow) => {
    const [url, pageTitle, heading] = file.targets[target]!;
    const link: SuggestedLink = { url, pageTitle, heading, relation, probability };
    if (position !== undefined && hash !== undefined) {
      link.origin = { position, hash };
    }
    return link;
  };

  const links = (anchor: string, pins: Array<string> = []) => {
    const section = sections.get(anchor);
    if (section === undefined) {
      return [];
    }
    const pinned = new Set(
      concepts.flatMap((concept, index) => (pins.includes(concept.id) ? [index] : [])),
    );
    const covers = ([target]: LinkRow) =>
      (file.targets[target]![3] ?? []).some(([concept]) => pinned.has(concept));
    if (!section.links.some(covers)) {
      return section.defaults.map((index) => suggested(section.links[index]!));
    }
    const candidates = section.links.map((row, index) => ({
      row,
      index,
      relation: row[1],
      page: file.targets[row[0]]![0].split("#")[0]!,
      covers: covers(row),
    }));
    candidates.sort(
      (first, second) => Number(second.covers) - Number(first.covers) || first.index - second.index,
    );
    return pickLinks(candidates).map((candidate) => suggested(candidate.row));
  };

  const allLinks = (anchor: string) => sections.get(anchor)?.links.map(suggested) ?? [];

  const rank = (sentences: Array<PageSentence>, weight: (sentence: PageSentence) => number) => {
    const candidates: Array<RankedLink & { page: string; score: number }> = [];
    for (const [anchor, group] of sentencesByAnchor(sentences)) {
      for (const link of allLinks(anchor)) {
        const sentence = link.origin && nearestSentence(group, link.origin);
        const score = sentence === undefined ? 0 : link.probability * weight(sentence);
        if (sentence !== undefined && score > 0) {
          candidates.push({ ...link, sentence, page: link.url.split("#")[0]!, score });
        }
      }
    }
    candidates.sort((first, second) => second.score - first.score);
    return pickLinks(candidates).map(({ page: _page, score: _score, ...link }) => link);
  };

  return { concepts, links, allLinks, rank };
}

/**
 * Loads a page's data file, by default the one `steerdown emit` wrote for the current page. A URL
 * that could be either a folder page or a file page tries both, folder first.
 */
export async function loadPage(dataUrl?: string): Promise<SteerdownPage> {
  const urls =
    dataUrl === undefined
      ? htmlFilesOf(browser().location.pathname).map((htmlFile) => `/${dataFilePath(htmlFile)}`)
      : [dataUrl];
  const statuses: Array<string> = [];

  for (const url of urls) {
    const response = await fetch(url);
    if (response.ok) {
      return pageFromData((await response.json()) as PageFile);
    }

    statuses.push(`${url} (status ${response.status})`);
  }

  throw new Error(`steerdown: no page data at ${statuses.join(" or ")}`);
}

/** The pinned concept ids saved in this browser for this site. */
export function readPins(): Array<string> {
  try {
    const saved: unknown = JSON.parse(browser().localStorage.getItem(pinsKey) ?? "[]");
    return Array.isArray(saved) ? saved.filter((id) => typeof id === "string") : [];
  } catch {
    return [];
  }
}

/** Saves the pinned concept ids in this browser for this site. Does nothing where storage is blocked. */
export function savePins(pins: Array<string>) {
  try {
    browser().localStorage.setItem(pinsKey, JSON.stringify(pins));
  } catch {
    // Storage is blocked or full, so the pins are not saved.
  }
}

/** The build's sentence hash: SHA-256 of the JSON string, as hex, cut to its length. */
async function sentenceHash(key: string) {
  const bytes = new TextEncoder().encode(JSON.stringify(key));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const hex = [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return hex.slice(0, hashLength);
}

/** The elements that hold the page's content, chosen as the build chooses them. */
function contentRoots(document: DomDocument) {
  const bodies = pagefindBodies(document, domAdapter);
  if (bodies.length > 0) {
    return bodies;
  }
  const root =
    firstElement(document, domAdapter, "main") ?? firstElement(document, domAdapter, "body");
  return root === undefined ? [] : [root];
}

/** Where each letter or digit of the text nodes' key sits: its node and character span. */
function keyPositions(nodes: Array<DomNode>) {
  const positions: Array<{ node: DomNode; start: number; end: number }> = [];
  let key = "";
  for (const node of nodes) {
    let start = 0;
    for (const character of node.data ?? "") {
      const part = sentenceKey(character);
      for (let count = 0; count < part.length; count++) {
        positions.push({ node, start, end: start + character.length });
      }
      key += part;
      start += character.length;
    }
  }
  return { key, positions };
}

type SplitSection = ReturnType<typeof splitContent<DomNode>>["sections"][number];

/** A section's sentences that have letters or digits, each with its hash and Range. */
async function sectionSentences(document: DomDocument, section: SplitSection) {
  const keys = splitSentences(section.blocks).map(sentenceKey);
  const hashes = await Promise.all(keys.map(sentenceHash));
  const nodes = section.blocks.flatMap((block) => block.sources ?? []);
  const { key, positions } = keyPositions(nodes);
  const sentences: Array<PageSentence> = [];
  let searchFrom = 0;
  for (const [position, sentence] of keys.entries()) {
    // Text the build leaves out, such as code blocks, can sit between two sentences.
    const start = sentence === "" ? -1 : key.indexOf(sentence, searchFrom);
    if (start !== -1) {
      const first = positions[start]!;
      const last = positions[start + sentence.length - 1]!;
      const range = document.createRange();
      range.setStart(first.node, first.start);
      range.setEnd(last.node, last.end);
      sentences.push({
        anchor: section.anchor,
        position,
        hash: hashes[position]!,
        range: range as BrowserRange,
      });
      searchFrom = start + sentence.length;
    }
  }
  return sentences;
}

/** The page's sections, split as the build splits them, with the text nodes they come from. */
function splitPage() {
  const { document } = browser();
  const { sections } = splitContent(contentRoots(document), domAdapter, { keepSources: true });
  return { document, sections };
}

/**
 * Every sentence of the page that has letters or digits, in page order, split as the build splits
 * it. A site checks their Ranges to tell which ones a reader is on.
 */
export async function readSentences(): Promise<Array<PageSentence>> {
  const { document, sections } = splitPage();
  const bySection = await Promise.all(
    sections.map((section) => sectionSentences(document, section)),
  );
  return bySection.flat();
}

/**
 * The Range over the sentence a link grows out of, in the section with the given anchor, or
 * undefined when the page no longer has it. The sentence is found by its hash, nearest to its
 * stored position.
 */
export async function originRange(
  anchor: string,
  link: SuggestedLink,
): Promise<BrowserRange | undefined> {
  const { document, sections } = splitPage();
  const section = sections.find((candidate) => candidate.anchor === anchor);
  if (link.origin === undefined || section === undefined) {
    return undefined;
  }
  return nearestSentence(await sectionSentences(document, section), link.origin)?.range;
}
