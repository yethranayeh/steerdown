type Vector = Map<string, number>;

const wordPattern = /[\p{L}\p{N}_]+/gu;

/** TF-IDF vectors of the given texts, normalized so a dot product is their cosine similarity. */
export function tfidfVectors(texts: string[]): Vector[] {
  const words = texts.map((text) => text.toLowerCase().match(wordPattern) ?? []);
  const documentFrequency = new Map<string, number>();
  for (const textWords of words) {
    for (const word of new Set(textWords)) {
      documentFrequency.set(word, (documentFrequency.get(word) ?? 0) + 1);
    }
  }
  return words.map((textWords) => {
    const vector: Vector = new Map();
    for (const word of textWords) {
      vector.set(word, (vector.get(word) ?? 0) + 1);
    }
    let squaredLength = 0;
    for (const [word, count] of vector) {
      const weight = count * Math.log(texts.length / documentFrequency.get(word)!);
      vector.set(word, weight);
      squaredLength += weight * weight;
    }
    const length = Math.sqrt(squaredLength) || 1;
    for (const [word, weight] of vector) {
      vector.set(word, weight / length);
    }
    return vector;
  });
}

export function cosine(first: Vector, second: Vector): number {
  const [smaller, larger] = first.size < second.size ? [first, second] : [second, first];
  let sum = 0;
  for (const [word, weight] of smaller) {
    sum += weight * (larger.get(word) ?? 0);
  }
  return sum;
}
