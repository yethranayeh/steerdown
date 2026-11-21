import type { Block } from "./split.ts";

import { isProse } from "./split.ts";

const sentenceSegmenter = new Intl.Segmenter("en", { granularity: "sentence" });

/**
 * The sentences of a block's text. A sentence ends only on a character outside inline code, so
 * punctuation inside code, such as the `?` of `{ next? }`, never ends one.
 */
function blockSentences(block: Block) {
  const isInCode = (offset: number) =>
    (block.codeSpans ?? []).some(({ start, end }) => start <= offset && offset < end);
  const sentences: Array<string> = [];
  let sentence = "";
  for (const { segment, index } of sentenceSegmenter.segment(block.text)) {
    const trailingSpace = sentence.length - sentence.trimEnd().length;
    const lastCharacter = index - trailingSpace - 1;
    const continuesSentence = sentence !== "" && isInCode(lastCharacter);
    if (!continuesSentence) {
      sentences.push(sentence.trim());
      sentence = "";
    }
    sentence += segment;
  }
  sentences.push(sentence.trim());
  return sentences.filter((text) => text !== "");
}

/** The sentences of a section's paragraphs and list items, in reading order. */
export function splitSentences(blocks: Array<Block>) {
  return blocks.filter(isProse).flatMap(blockSentences);
}

/** What a sentence's hash covers: its letters and digits, NFKC-normalized and lowercased. */
export function sentenceKey(sentence: string) {
  return sentence
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, "");
}
