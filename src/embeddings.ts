import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { inBatches, postJson, runPooled } from "./http.ts";
import { hash, requestsInFlight } from "./judge.ts";

/** An OpenAI-compatible embeddings endpoint: its base URL (ending in /v1), model and key. */
export type EmbeddingClient = { url: string; model: string; apiKey: string | undefined };

type EmbeddingResponse = { data: Array<{ index: number; embedding: Array<number> }> };

/** The cache file: vectors of one model, each a base64 string of float32 values, by text hash. */
type CacheFile = { model: string; vectors: Record<string, string> };

/** Vectors by the hash of their text, each scaled to length 1. */
export type Vectors = Map<string, Float32Array>;

export type EmbeddingProgress = { requests: number; embedded: number; failure: unknown };

const textsPerRequest = 64;

/** The vector cache, next to the graph file. */
export function embeddingCachePath(graphPath: string) {
  return join(dirname(graphPath), "steerdown.embeddings.json");
}

export function textHash(text: string) {
  return hash(text);
}

function normalized(values: ArrayLike<number>): Float32Array {
  const vector = Float32Array.from(values);
  let squaredLength = 0;
  for (const value of vector) {
    squaredLength += value * value;
  }
  const length = Math.sqrt(squaredLength) || 1;
  return vector.map((value) => value / length);
}

function decodeVector(encoded: string): Float32Array {
  const bytes = Buffer.from(encoded, "base64");
  const copy = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  return new Float32Array(copy);
}

function encodeVector(vector: Float32Array) {
  return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength).toString("base64");
}

/** Reads the cached vectors of a model. Vectors of another model are not comparable, so none are kept. */
function readCache(path: string, model: string): Vectors {
  const vectors: Vectors = new Map();
  if (!existsSync(path)) {
    return vectors;
  }
  const cache = JSON.parse(readFileSync(path, "utf8")) as CacheFile;
  if (cache.model !== model) {
    return vectors;
  }
  for (const [key, encoded] of Object.entries(cache.vectors)) {
    vectors.set(key, decodeVector(encoded));
  }
  return vectors;
}

/** Writes the vectors of the given text hashes that are known, dropping any the build no longer uses. */
function writeCache(
  path: string,
  client: EmbeddingClient,
  known: { vectors: Vectors; keys: Array<string> },
) {
  const cache: CacheFile = { model: client.model, vectors: {} };
  for (const key of known.keys) {
    const vector = known.vectors.get(key);
    if (vector !== undefined) {
      cache.vectors[key] = encodeVector(vector);
    }
  }
  writeFileSync(path, `${JSON.stringify(cache)}\n`);
}

/** Asks the endpoint for one batch of texts and stores their vectors. */
async function embedBatch(client: EmbeddingClient, batch: Array<string>, vectors: Vectors) {
  const response = await postJson<EmbeddingResponse>({
    url: `${client.url.replace(/\/+$/, "")}/embeddings`,
    apiKey: client.apiKey,
    body: { model: client.model, input: batch },
    service: "The embedding endpoint",
  });
  if (response.data?.length !== batch.length) {
    throw new Error(
      `The embedding endpoint returned ${response.data?.length ?? 0} vectors for ${batch.length} texts.`,
    );
  }
  for (const { index, embedding } of response.data) {
    vectors.set(textHash(batch[index]!), normalized(embedding));
  }
}

/**
 * Returns a vector for every text, embedding only texts the cache lacks, and rewrites the cache.
 * When a request fails, the vectors so far are cached and the failure is returned.
 */
export async function embedTexts({
  client,
  texts,
  cachePath,
}: {
  client: EmbeddingClient;
  texts: Array<string>;
  cachePath: string;
}): Promise<{ vectors: Vectors; progress: EmbeddingProgress }> {
  const vectors = readCache(cachePath, client.model);
  const unique = [...new Map(texts.map((text) => [textHash(text), text])).values()];
  const missing = unique.filter((text) => !vectors.has(textHash(text)));
  const progress: EmbeddingProgress = { requests: 0, embedded: 0, failure: undefined };

  try {
    await runPooled(inBatches(missing, textsPerRequest), requestsInFlight, async (batch) => {
      await embedBatch(client, batch, vectors);
      progress.requests++;
      progress.embedded += batch.length;
    });
  } catch (error) {
    progress.failure = error;
  }

  writeCache(cachePath, client, { vectors, keys: unique.map(textHash) });
  return { vectors, progress };
}
