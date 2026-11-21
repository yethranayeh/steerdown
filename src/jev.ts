export const officialEndpoint = "https://api.typesafe.ai/v1/systemone";

export type JevClient = { endpoint: string; apiKey: string | undefined };

export type ChoiceAnswer = {
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
};

export type ScoreAnswer = {
  score: number;
  confidence: number;
};

export type JevResponse<Answer = ChoiceAnswer> = {
  model: string;
  answers: Record<string, Answer>;
  usage: { input_tokens: number };
};

export class JevError extends Error {}

const retriedStatuses = new Set([429, 529]);
const maximumRetries = 7;
const firstRetryDelayMs = 1000;
const longestRetryDelayMs = 60_000;

function sleep(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function retryDelay(attempt: number, retryAfter: string | null): number {
  const retryAfterSeconds = Number(retryAfter);
  const serverGaveDelay =
    retryAfter !== null && retryAfter !== "" && Number.isFinite(retryAfterSeconds);
  if (serverGaveDelay) {
    return Math.max(0, retryAfterSeconds * 1000);
  }
  return Math.min(longestRetryDelayMs, firstRetryDelayMs * 2 ** attempt) + Math.random() * 500;
}

/** Sends one System One request, retrying rate-limited (429) and overloaded (529) responses. */
export async function askJev<Answer = ChoiceAnswer>(
  client: JevClient,
  body: object,
): Promise<JevResponse<Answer>> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (client.apiKey !== undefined) {
    headers.authorization = `Bearer ${client.apiKey}`;
  }
  const send = () =>
    fetch(client.endpoint, { method: "POST", headers, body: JSON.stringify(body) });

  let response = await send();
  for (let retry = 0; retriedStatuses.has(response.status) && retry < maximumRetries; retry++) {
    await response.body?.cancel();
    await sleep(retryDelay(retry, response.headers.get("retry-after")));
    response = await send();
  }
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 300);
    throw new JevError(`Jev returned status ${response.status}: ${detail}`);
  }
  return (await response.json()) as JevResponse<Answer>;
}

/** Runs `work` over every item with at most `limit` running at once, stopping at the first error. */
export async function runPooled<T>(
  items: Array<T>,
  limit: number,
  work: (item: T) => Promise<void>,
): Promise<void> {
  let nextIndex = 0;
  const errors: Array<unknown> = [];
  const hasWorkLeft = () => errors.length === 0 && nextIndex < items.length;

  async function worker() {
    while (hasWorkLeft()) {
      const item = items[nextIndex]!;
      nextIndex++;
      try {
        await work(item);
      } catch (error) {
        errors.push(error);
      }
    }
  }

  const workerCount = Math.min(limit, items.length);
  await Promise.all(Array.from({ length: workerCount }, worker));
  if (errors.length > 0) {
    throw errors[0];
  }
}
