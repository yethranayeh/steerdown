import type { EmbeddingClient, Vectors } from "./embeddings.ts";
import type { Edge, GraphSection, Origin } from "./graph.ts";
import type { Section } from "./sections.ts";

import { embeddingCachePath, embedTexts, textHash } from "./embeddings.ts";
import { hash, judgedState, round } from "./judge.ts";
import { candidatesBySection } from "./rank.ts";
import { sentenceKey, splitSentences } from "./sentences.ts";

export type OriginReport = {
  links: number;
  /** Links left without a sentence because the nearest one is below the minimum similarity. */
  belowMinimum: number;
  embedded: number;
  requests: number;
};

/** A build's origin sentences: the graph fields it writes, its report and the error that stopped it. */
export type OriginRun = {
  fields: { embeddingModel?: string; origins?: Array<Origin> };
  report: OriginReport | undefined;
  failure: unknown;
};

/** What a link target is compared by: the page title, heading and the text Jev reads. */
function targetText(section: Section) {
  const { page_title, heading, text } = judgedState(section);
  const title = heading === "" ? page_title : `${page_title}: ${heading}`;

  return `${title}\n\n${text}`;
}

function dot(first: Float32Array, second: Float32Array) {
  let sum = 0;
  for (let index = 0; index < first.length; index++) {
    sum += first[index]! * second[index]!;
  }

  return sum;
}

/** The position and similarity of the sentence nearest to the target. */
function nearestSentence(sentences: Array<Float32Array>, target: Float32Array) {
  let best = { position: 0, similarity: -Infinity };
  sentences.forEach((sentence, position) => {
    const similarity = dot(sentence, target);
    if (similarity > best.similarity) {
      best = { position, similarity };
    }
  });

  return best;
}

/** For every showable link, the source sentence nearest to the target, unless it is below the minimum. */
function pickOrigins({
  sentencesBySection,
  targets,
  links,
  vectors,
  minSimilarity,
}: {
  sentencesBySection: Array<Array<string>>;
  targets: Array<string>;
  links: Array<Array<{ to: number }>>;
  vectors: Vectors;
  minSimilarity: number | undefined;
}): { origins: Array<Origin>; belowMinimum: number } {
  const vectorOf = (text: string) => vectors.get(textHash(text))!;
  const origins: Array<Origin> = [];
  let belowMinimum = 0;

  links.forEach((candidates, from) => {
    const sentences = sentencesBySection[from]!;
    if (sentences.length === 0) {
      return;
    }

    const sentenceVectors = sentences.map(vectorOf);
    for (const { to } of candidates) {
      const { position, similarity } = nearestSentence(sentenceVectors, vectorOf(targets[to]!));
      if (minSimilarity !== undefined && similarity < minSimilarity) {
        belowMinimum++;
        continue;
      }

      origins.push([
        from,
        to,
        position,
        hash(sentenceKey(sentences[position]!)),
        round(similarity),
      ]);
    }
  });

  return { origins, belowMinimum };
}

/**
 * Finds the sentence each showable link grows out of: the sentence of the source section whose
 * embedding is nearest to the target's. Without an embedding client it finds none. A link whose
 * nearest sentence is below `minSimilarity` gets none.
 */
export async function findOrigins({
  client,
  sections,
  graphSections,
  edges,
  scopes,
  graphPath,
  minSimilarity,
}: {
  client: EmbeddingClient | undefined;
  sections: Array<Section>;
  graphSections: Array<GraphSection>;
  edges: Array<Edge>;
  scopes: Array<string>;
  graphPath: string;
  minSimilarity: number | undefined;
}): Promise<OriginRun> {
  if (client === undefined) {
    return { fields: {}, report: undefined, failure: undefined };
  }

  const links = candidatesBySection(graphSections, edges, scopes);
  const sentencesBySection = sections.map((section) => splitSentences(section.blocks));
  const targets = sections.map(targetText);
  const neededTargets = new Set(links.flat().map(({ to }) => to));
  const texts = [
    ...links.flatMap((candidates, from) =>
      candidates.length > 0 ? sentencesBySection[from]! : [],
    ),
    ...[...neededTargets].map((to) => targets[to]!),
  ];

  const { vectors, progress } = await embedTexts({
    client,
    texts,
    cachePath: embeddingCachePath(graphPath),
  });
  const { requests, embedded, failure } = progress;
  if (failure !== undefined) {
    return { fields: {}, report: { links: 0, belowMinimum: 0, embedded, requests }, failure };
  }

  const picked = pickOrigins({ sentencesBySection, targets, links, vectors, minSimilarity });
  const { origins, belowMinimum } = picked;

  return {
    fields: { embeddingModel: client.model, origins },
    report: { links: origins.length, belowMinimum, embedded, requests },
    failure: undefined,
  };
}
