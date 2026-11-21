export const officialEndpoint = "https://api.typesafe.ai/v1/systemone";

export type JevClient = { endpoint: string; apiKey: string | undefined };

export type ChoiceAnswer = {
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
};

export type JevResponse = {
  model: string;
  answers: Record<string, ChoiceAnswer>;
  usage: { input_tokens: number };
};

export class JevError extends Error {}

const retriedStatuses = new Set([429, 529]);
const maximumAttempts = 8;
const firstRetryDelayMs = 1000;
const longestRetryDelayMs = 60_000;

const sleep = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

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
export async function askJev(client: JevClient, body: object): Promise<JevResponse> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (client.apiKey !== undefined) {
    headers.authorization = `Bearer ${client.apiKey}`;
  }
  for (let attempt = 1; ; attempt++) {
    const response = await fetch(client.endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    if (response.ok) {
      return (await response.json()) as JevResponse;
    }
    const canRetry = retriedStatuses.has(response.status) && attempt < maximumAttempts;
    if (!canRetry) {
      const detail = (await response.text()).slice(0, 300);
      throw new JevError(`Jev returned status ${response.status}: ${detail}`);
    }
    await response.body?.cancel();
    await sleep(retryDelay(attempt - 1, response.headers.get("retry-after")));
  }
}

/** Runs `work` over every item with at most `limit` running at once, stopping at the first error. */
export async function runPooled<T>(
  items: T[],
  limit: number,
  work: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  let failed = false;
  const errors: unknown[] = [];
  const worker = async () => {
    while (!failed && next < items.length) {
      const item = items[next++]!;
      try {
        await work(item);
      } catch (error) {
        failed = true;
        errors.push(error);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  if (errors.length > 0) {
    throw errors[0];
  }
}
