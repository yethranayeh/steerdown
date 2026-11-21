/**
 * The browser API: a page's suggested links and the sentence each one grows out of. It draws
 * nothing. The site renders the links and any highlight. Bundled on its own for the browser, so
 * keep it free of Node imports.
 */
import type { PageFile } from "./emit.ts";
import type { NodeAdapter } from "./split.ts";

import { pickLinks } from "./pick.ts";
import {
  firstElement,
  pagefindBodies,
  sentenceKey,
  splitContent,
  splitSentences,
} from "./split.ts";
import { dataFilePath, htmlFileOf } from "./urls.ts";

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

export type SteerdownPage = {
  /** The concepts a reader can pin, empty when the site has no concept file. */
  concepts: Array<Concept>;
  /**
   * A section's three links. The anchor is the section's id, empty for the page intro. Pinned
   * concept ids put the targets that cover them first.
   */
  links: (anchor: string, pins?: Array<string>) => Array<SuggestedLink>;
};

type PageSection = PageFile["sections"][number];
type LinkRow = PageSection["links"][number];

/** The id after the `#` in a section id, empty for a page intro. */
function anchorOf(sectionId: string) {
  const hashAt = sectionId.indexOf("#");
  return hashAt === -1 ? "" : sectionId.slice(hashAt + 1);
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

  return { concepts, links };
}

/** Loads a page's data file, by default the one `steerdown emit` wrote for the current page. */
export async function loadPage(dataUrl?: string): Promise<SteerdownPage> {
  const url = dataUrl ?? `/${dataFilePath(htmlFileOf(browser().location.pathname))}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`steerdown: no page data at ${url} (status ${response.status})`);
  }
  return pageFromData((await response.json()) as PageFile);
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

/** The sentence position with the given hash nearest to the stored one, or -1 when none has it. */
function nearestPosition(hashes: Array<string>, hash: string, stored: number) {
  let found = -1;
  hashes.forEach((candidate, position) => {
    const isCloser = found === -1 || Math.abs(position - stored) < Math.abs(found - stored);
    if (candidate === hash && isCloser) {
      found = position;
    }
  });
  return found;
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

/**
 * The Range over the sentence a link grows out of, in the section with the given anchor, or
 * undefined when the page no longer has it. The section is split as the build splits it, and the
 * sentence is found by its hash, nearest to its stored position. The Range runs from its first
 * letter or digit to its last.
 */
export async function originRange(
  anchor: string,
  link: SuggestedLink,
): Promise<DomRange | undefined> {
  const { document } = browser();
  const split = splitContent(contentRoots(document), domAdapter, { keepSources: true });
  const section = split.sections.find((candidate) => candidate.anchor === anchor);
  if (link.origin === undefined || section === undefined) {
    return undefined;
  }

  const keys = splitSentences(section.blocks).map(sentenceKey);
  const hashes = await Promise.all(keys.map(sentenceHash));
  const position = nearestPosition(hashes, link.origin.hash, link.origin.position);
  const sentence = keys[position];
  if (sentence === undefined || sentence === "") {
    return undefined;
  }

  const nodes = section.blocks.flatMap((block) => block.sources ?? []);
  const { key, positions } = keyPositions(nodes);
  const expected = keys.slice(0, position).join("").length;
  const start = key.startsWith(sentence, expected) ? expected : key.indexOf(sentence);
  if (start === -1) {
    return undefined;
  }
  const first = positions[start]!;
  const last = positions[start + sentence.length - 1]!;
  const range = document.createRange();
  range.setStart(first.node, first.start);
  range.setEnd(last.node, last.end);
  return range;
}
