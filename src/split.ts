/**
 * Splits a built HTML page into sections and blocks. It walks nodes only through a `NodeAdapter`,
 * so the build passes parse5 nodes and a browser can pass DOM nodes to the same code. Keep it free
 * of DOM globals and parser imports.
 */

/** Reads one node. Element names are lowercase. */
export type NodeAdapter<N> = {
  /** The tag name of an element, undefined for any other node. */
  name: (node: N) => string | undefined;
  attribute: (node: N, name: string) => string | undefined;
  children: (node: N) => Iterable<N>;
  /** The text of a text node, undefined for any other node. */
  text: (node: N) => string | undefined;
};

/**
 * One line of a section. Headings carry their level. `linkLed` marks a paragraph that is only a
 * link, a list item that starts with one, or a block inside a link.
 */
export type Block = {
  kind: "paragraph" | "item" | "heading" | "code" | "table";
  text: string;
  level?: number;
  linkLed?: boolean;
};

/** A section of a page. The anchor is the id it starts at, empty for the page intro. */
export type SplitSection = { anchor: string; heading: string; blocks: Array<Block> };

export type SplitPage = {
  /** The first `h1` in the content, empty when there is none. */
  title: string;
  sections: Array<SplitSection>;
  /** The text of each `h2` that has no id to start a section at. */
  idlessHeadings: Array<string>;
};

const droppedElements = new Set(
  (
    "nav footer script style template svg noscript form button input select textarea option " +
    "optgroup datalist output meter progress"
  ).split(" "),
);

/** Elements that end the running line of text before them and after them. */
const blockElements = new Set(
  (
    "address article aside blockquote caption dd details dialog div dl dt fieldset figcaption " +
    "figure header hgroup hr legend li main menu ol p pre search section summary table tbody " +
    "td tfoot th thead tr ul"
  ).split(" "),
);

const headingLevels: Record<string, number> = { h1: 1, h2: 2, h3: 3, h4: 4, h5: 5, h6: 6 };
const htmlWhitespace = /[ \t\n\r\f]+/g;
const linkListShareForHub = 0.6;
const firstMarkedHeadingLevel = 3;

function collapse(text: string) {
  return text.replace(htmlWhitespace, " ").trim();
}

/** True for content the reader never reads as text: page chrome, controls and hidden decoration. */
export function isDropped<N>(node: N, adapter: NodeAdapter<N>) {
  return (
    droppedElements.has(adapter.name(node)!) ||
    adapter.attribute(node, "data-pagefind-ignore") !== undefined ||
    adapter.attribute(node, "aria-hidden") === "true"
  );
}

/** True when a link points at the heading it belongs to, such as a `#` anchor link. */
function isSelfLink(href: string | undefined, selfId: string | undefined) {
  return href !== undefined && selfId !== undefined && href === `#${selfId}`;
}

/** The kept child elements of a node, with their names. */
function* elementsOf<N>(node: N, adapter: NodeAdapter<N>) {
  for (const child of adapter.children(node)) {
    const name = adapter.name(child);
    if (name !== undefined && !isDropped(child, adapter)) {
      yield { child, name };
    }
  }
}

/** Every element under a node that matches, not looking inside a match. */
function findAll<N>(node: N, adapter: NodeAdapter<N>, matches: (element: N) => boolean) {
  const found: Array<N> = [];
  for (const child of adapter.children(node)) {
    if (adapter.name(child) === undefined) {
      continue;
    }
    if (matches(child)) {
      found.push(child);
    } else {
      found.push(...findAll(child, adapter, matches));
    }
  }
  return found;
}

/** The elements marked `data-pagefind-body`, outermost only. */
export function pagefindBodies<N>(document: N, adapter: NodeAdapter<N>) {
  return findAll(
    document,
    adapter,
    (node) => adapter.attribute(node, "data-pagefind-body") !== undefined,
  );
}

/** The first element with the given name, in document order. */
export function firstElement<N>(document: N, adapter: NodeAdapter<N>, name: string) {
  return findAll(document, adapter, (node) => adapter.name(node) === name)[0];
}

/** The text of `head > title`, empty when the page has none. */
export function documentTitle<N>(document: N, adapter: NodeAdapter<N>) {
  let node: N | undefined = document;
  for (const name of ["html", "head", "title"]) {
    const parent: N = node;
    node = [...adapter.children(parent)].find((child) => adapter.name(child) === name);
    if (node === undefined) {
      return "";
    }
  }
  return collapse([...adapter.children(node)].map((child) => adapter.text(child) ?? "").join(""));
}

/** The text under a node on one line, leaving out dropped content and links to `selfId`. */
function inlineText<N>(node: N, adapter: NodeAdapter<N>, selfId: string | undefined): string {
  const parts: Array<string> = [];
  const collect = (parent: N) => {
    for (const child of adapter.children(parent)) {
      const text = adapter.text(child);
      const name = adapter.name(child);
      if (text !== undefined) {
        parts.push(text);
      } else if (name === "br") {
        parts.push(" ");
      } else if (name !== undefined && !isDropped(child, adapter)) {
        const isSkipped = name === "a" && isSelfLink(adapter.attribute(child, "href"), selfId);
        if (!isSkipped) {
          collect(child);
        }
      }
    }
  };
  collect(node);
  return collapse(parts.join(""));
}

/** The shared leading whitespace of the lines. */
function commonIndent(lines: Array<string>) {
  return lines
    .map((line) => line.match(/^[ \t]*/)![0])
    .reduce((shared, indent) => {
      let length = 0;
      while (length < shared.length && shared[length] === indent[length]) {
        length++;
      }
      return shared.slice(0, length);
    });
}

/** True for whitespace that only indents markup: a text node of whitespace with a line break. */
function isMarkupIndentation(text: string, isBeforeCode: boolean) {
  const isBlank = text.trim() === "";
  return isBlank && (isBeforeCode || text.includes("\n"));
}

/**
 * The text of a code block, a line per source line and per block element inside it, without
 * blank lines or the indentation every line shares. Whitespace that only indents the markup,
 * or comes before any code, counts as a line break.
 */
function codeText<N>(pre: N, adapter: NodeAdapter<N>) {
  const parts: Array<string> = [];
  let isBeforeCode = true;
  const collect = (parent: N) => {
    for (const child of adapter.children(parent)) {
      const text = adapter.text(child);
      const name = adapter.name(child);
      if (text !== undefined) {
        parts.push(isMarkupIndentation(text, isBeforeCode) ? "\n" : text);
        isBeforeCode &&= text.trim() === "";
      } else if (name === "br") {
        parts.push("\n");
      } else if (name !== undefined && !isDropped(child, adapter)) {
        const breaks = blockElements.has(name) ? "\n" : "";
        parts.push(breaks);
        collect(child);
        parts.push(breaks);
      }
    }
  };
  collect(pre);
  const lines = parts
    .join("")
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line !== "");
  if (lines.length === 0) {
    return "";
  }
  const indent = commonIndent(lines);
  return lines.map((line) => line.slice(indent.length)).join("\n");
}

/** A table's caption and rows, a line each, with a row's cells joined by ` | `. */
function tableText<N>(table: N, adapter: NodeAdapter<N>) {
  const lines: Array<string> = [];
  const isRowPart = (name: string) => name === "caption" || name === "tr";
  for (const part of findAll(table, adapter, (node) => isRowPart(adapter.name(node)!))) {
    if (isDropped(part, adapter)) {
      continue;
    }
    const isCaption = adapter.name(part) === "caption";
    const cells = isCaption
      ? [inlineText(part, adapter, undefined)]
      : [...elementsOf(part, adapter)].map(({ child }) => inlineText(child, adapter, undefined));
    const line = cells.join(" | ").trim();
    if (line.replace(/[ |]/g, "") !== "") {
      lines.push(line);
    }
  }
  return lines.join("\n");
}

/** The number of kept `h2` elements under a node. */
function countH2<N>(node: N, adapter: NodeAdapter<N>): number {
  let count = 0;
  for (const { child, name } of elementsOf(node, adapter)) {
    count += name === "h2" ? 1 : countH2(child, adapter);
  }
  return count;
}

/** An element with an id the walk is inside, and whether kept text came before this point in it. */
type IdHolder<N> = { id: string; node: N; textSeen: boolean };

/** Walks a page's content in document order and collects its sections and blocks. */
class PageSplitter<N> {
  private title: string | undefined;
  private readonly sections: Array<SplitSection> = [{ anchor: "", heading: "", blocks: [] }];
  private readonly idlessHeadings: Array<string> = [];
  /** The running line of text and whether each part of it is inside a link. */
  private run: Array<{ text: string; linked: boolean }> = [];
  private linkDepth = 0;
  private itemPending = false;
  /** The id of the latest heading, whose own anchor links are left out of the text. */
  private headingId: string | undefined;
  private readonly idHolders: Array<IdHolder<N>> = [];

  constructor(private readonly adapter: NodeAdapter<N>) {}

  split(roots: Array<N>): SplitPage {
    for (const root of roots) {
      this.walkChildren(root);
    }
    this.flush();
    const [intro, ...rest] = this.sections;
    const sections = intro!.blocks.length > 0 ? this.sections : rest;
    return { title: this.title ?? "", sections, idlessHeadings: this.idlessHeadings };
  }

  private walkChildren(node: N) {
    for (const child of this.adapter.children(node)) {
      this.walk(child);
    }
  }

  private walk(node: N) {
    const text = this.adapter.text(node);
    if (text !== undefined) {
      this.addText(text);
      return;
    }
    const name = this.adapter.name(node);
    if (name === undefined || isDropped(node, this.adapter)) {
      return;
    }
    const id = this.adapter.attribute(node, "id") || undefined;
    if (id !== undefined) {
      this.idHolders.push({ id, node, textSeen: false });
    }
    this.visit(node, name);
    if (id !== undefined) {
      this.idHolders.pop();
    }
  }

  private visit(node: N, name: string) {
    const level = headingLevels[name];
    if (level !== undefined) {
      this.addHeading(node, level);
    } else if (name === "pre") {
      this.addBlock({ kind: "code", text: codeText(node, this.adapter) });
    } else if (name === "table") {
      this.addBlock({ kind: "table", text: tableText(node, this.adapter) });
    } else if (name === "br") {
      this.addText(" ");
    } else if (name === "a") {
      this.visitLink(node);
    } else if (blockElements.has(name)) {
      this.visitBlock(node, name);
    } else {
      this.walkChildren(node);
    }
  }

  /** Walks a block element. A list item's first line of text becomes the item. */
  private visitBlock(node: N, name: string) {
    const isItem = name === "li";
    this.flush();
    this.itemPending ||= isItem;
    this.walkChildren(node);
    this.flush();
    this.itemPending &&= !isItem;
  }

  private visitLink(node: N) {
    const href = this.adapter.attribute(node, "href");
    if (isSelfLink(href, this.headingId)) {
      return;
    }
    const isLink = href !== undefined;
    this.linkDepth += isLink ? 1 : 0;
    this.walkChildren(node);
    this.linkDepth -= isLink ? 1 : 0;
  }

  private markTextSeen() {
    for (const holder of this.idHolders) {
      holder.textSeen = true;
    }
  }

  private addText(text: string) {
    this.run.push({ text, linked: this.linkDepth > 0 });
    if (text.trim() !== "") {
      this.markTextSeen();
    }
  }

  /** Ends the running line as a paragraph, or as a list item when it opens one. */
  private flush() {
    const parts = this.run.filter((part) => part.text.trim() !== "");
    const text = collapse(this.run.map((part) => part.text).join(""));
    this.run = [];
    if (text === "") {
      return;
    }
    const kind = this.itemPending ? "item" : "paragraph";
    this.itemPending = false;
    const allLinked = parts.every((part) => part.linked);
    const startsWithLink = kind === "item" && parts[0]!.linked;
    this.sections.at(-1)!.blocks.push({ kind, text, linkLed: allLinked || startsWithLink });
  }

  private addBlock(block: Block) {
    this.flush();
    if (block.text !== "") {
      this.sections.at(-1)!.blocks.push(block);
      this.markTextSeen();
    }
  }

  /** The id of the closest element with an id, when it holds this `h2` alone and no text before it. */
  private wrapperId() {
    const holder = this.idHolders.at(-1);
    if (holder === undefined || holder.textSeen || countH2(holder.node, this.adapter) !== 1) {
      return undefined;
    }
    return holder.id;
  }

  private addHeading(node: N, level: number) {
    this.flush();
    const ownId = this.adapter.attribute(node, "id") || undefined;
    if (level === 1 && this.title === undefined) {
      this.title = inlineText(node, this.adapter, ownId);
      this.markTextSeen();
      return;
    }
    const anchor = level === 2 ? (ownId ?? this.wrapperId()) : undefined;
    if (anchor !== undefined) {
      const heading = inlineText(node, this.adapter, anchor);
      this.sections.push({ anchor, heading, blocks: [] });
      this.headingId = anchor;
      this.markTextSeen();
      return;
    }
    const text = inlineText(node, this.adapter, ownId);
    if (level === 2) {
      this.idlessHeadings.push(text);
    }
    this.headingId = ownId;
    this.addBlock({ kind: "heading", text, level });
  }
}

/**
 * Splits page content into sections. A section starts at an `h2` with an id, or at an `h2` whose
 * closest element with an id holds no other `h2` and no text before it. Text before the first
 * section is the page intro, left out when empty.
 */
export function splitContent<N>(roots: Array<N>, adapter: NodeAdapter<N>): SplitPage {
  return new PageSplitter(adapter).split(roots);
}

/**
 * The text Jev reads: a line per block, `- ` before list items, `### ` before `h3` to `h6`, and
 * code fenced with three backticks.
 */
export function judgedText(blocks: Array<Block>) {
  const line = (block: Block) => {
    if (block.kind === "item") {
      return `- ${block.text}`;
    }
    if (block.kind === "code") {
      return `\`\`\`\n${block.text}\n\`\`\``;
    }
    const isMarkedHeading = block.kind === "heading" && block.level! >= firstMarkedHeadingLevel;
    return isMarkedHeading ? `### ${block.text}` : block.text;
  };
  return blocks.map(line).join("\n");
}

const sentenceSegmenter = new Intl.Segmenter("en", { granularity: "sentence" });

const isProse = (block: Block) => block.kind === "paragraph" || block.kind === "item";

/** The sentences of a section's paragraphs and list items, in reading order. */
export function splitSentences(blocks: Array<Block>) {
  const sentences: Array<string> = [];
  for (const block of blocks.filter(isProse)) {
    for (const { segment } of sentenceSegmenter.segment(block.text)) {
      const sentence = segment.trim();
      if (sentence !== "") {
        sentences.push(sentence);
      }
    }
  }
  return sentences;
}

/** What a sentence's hash covers: its letters and digits, NFKC-normalized and lowercased. */
export function sentenceKey(sentence: string) {
  return sentence
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, "");
}

/** True when most of a section's paragraphs and list items are links, as in a table of contents. */
export function isLinkHub(blocks: Array<Block>) {
  const prose = blocks.filter(isProse);
  if (prose.length === 0) {
    return false;
  }
  const linkLed = prose.filter((block) => block.linkLed).length;
  return linkLed / prose.length >= linkListShareForHub;
}
