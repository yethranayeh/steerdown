import type { Fence } from "./sections.ts";

import { closesFence, codeFenceOpening, renderedInline } from "./sections.ts";

const sentenceSegmenter = new Intl.Segmenter("en", { granularity: "sentence" });

const listItemMarker = /^\s*(?:[-*+]|\d+[.)])\s+/;
const blockquoteMarker = /^\s*>\s?/;
const headingLine = /^ {0,3}#{1,6}(?:\s|$)/;
const tableLine = /^\s*\|/;
const thematicBreak = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
const linkDefinition = /^ {0,3}\[[^\]]+\]:\s/;

/** True when a line is left out of the reading text: headings, tables, rules and link definitions. */
function isSkippedLine(line: string) {
  return (
    headingLine.test(line) ||
    tableLine.test(line) ||
    thematicBreak.test(line) ||
    linkDefinition.test(line)
  );
}

/**
 * The paragraphs, list items and blockquotes of a section's Markdown, each as one line of text.
 * Code, tables and headings are left out.
 */
function textBlocks(markdown: string): Array<string> {
  const blocks: Array<string> = [];
  let current: Array<string> = [];
  let openFence: Fence | undefined;
  const endBlock = () => {
    if (current.length > 0) {
      blocks.push(current.join(" "));
    }
    current = [];
  };

  for (const line of markdown.split("\n")) {
    const fence = line.match(codeFenceOpening)?.[1];
    if (openFence !== undefined) {
      if (closesFence(line, fence, openFence)) {
        openFence = undefined;
      }
      continue;
    }

    if (fence !== undefined) {
      endBlock();
      openFence = { marker: fence[0]!, length: fence.length };
      continue;
    }

    if (line.trim() === "" || isSkippedLine(line)) {
      endBlock();
      continue;
    }

    if (listItemMarker.test(line)) {
      endBlock();
    }

    current.push(line.replace(blockquoteMarker, "").replace(listItemMarker, "").trim());
  }

  endBlock();

  return blocks;
}

/**
 * Splits a section's Markdown into the sentences a reader sees, in reading order. A link's origin
 * sentence is stored as a position in this list.
 */
export function splitSentences(markdown: string): Array<string> {
  const sentences: Array<string> = [];
  for (const block of textBlocks(markdown)) {
    for (const { segment } of sentenceSegmenter.segment(renderedInline(block))) {
      const sentence = segment.trim();
      if (sentence !== "") {
        sentences.push(sentence);
      }
    }
  }

  return sentences;
}
