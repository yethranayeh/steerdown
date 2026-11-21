import type { Section } from "./sections.ts";

import { createHash } from "node:crypto";

export const model = "jev-latest";
export const requestsInFlight = 4;
export const judgedWordLimit = 600;
/** Probabilities, scores and confidences are stored to three decimals. */
const storedPrecision = 1000;

/** Requests sent and tokens read while asking Jev, and the error that stopped it, if one did. */
export type RequestProgress = {
  requests: number;
  inputTokens: number;
  failure: unknown;
};

export function hash(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
}

export function round(value: number) {
  return Math.round(value * storedPrecision) / storedPrecision;
}

/** The text up to its word limit, keeping its line breaks. */
function truncated(text: string) {
  const words = [...text.matchAll(/\S+/g)];
  const lastWord = words[judgedWordLimit - 1];
  if (words.length <= judgedWordLimit || lastWord === undefined) {
    return text;
  }
  return text.slice(0, lastWord.index + lastWord[0].length);
}

/** The part of a section Jev reads. Its hash tells a rebuild whether the section changed. */
export function judgedState(section: Section) {
  return {
    page_title: section.pageTitle,
    heading: section.heading,
    text: truncated(section.text),
  };
}
