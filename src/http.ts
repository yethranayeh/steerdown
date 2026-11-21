export class RequestError extends Error {}

const retriedStatuses = new Set([429, 529]);
const maximumRetries = 7;
const firstRetryDelayMs = 1000;
const longestRetryDelayMs = 60_000;

function sleep(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function retryDelay(attempt: number, retryAfter: string | null) {
  const retryAfterSeconds = Number(retryAfter);
  const serverGaveDelay =
    retryAfter !== null && retryAfter !== "" && Number.isFinite(retryAfterSeconds);

  if (serverGaveDelay) {
    return Math.max(0, retryAfterSeconds * 1000);
  }

  return Math.min(longestRetryDelayMs, firstRetryDelayMs * 2 ** attempt) + Math.random() * 500;
}

/**
 * Posts a JSON body and returns the JSON answer, retrying rate-limited (429) and overloaded (529)
 * responses. `service` names the server in the error a failed request throws.
 */
export async function postJson<Answer>({
  url,
  apiKey,
  body,
  service,
}: {
  url: string;
  apiKey: string | undefined;
  body: object;
  service: string;
}): Promise<Answer> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (apiKey !== undefined) {
    headers.authorization = `Bearer ${apiKey}`;
  }

  const send = () => fetch(url, { method: "POST", headers, body: JSON.stringify(body) });

  let response = await send();
  for (let retry = 0; retriedStatuses.has(response.status) && retry < maximumRetries; retry++) {
    await response.body?.cancel();
    await sleep(retryDelay(retry, response.headers.get("retry-after")));
    response = await send();
  }

  if (!response.ok) {
    const detail = (await response.text()).slice(0, 300);
    throw new RequestError(`${service} returned status ${response.status}: ${detail}`);
  }

  return (await response.json()) as Answer;
}

/** Splits a list into consecutive batches of at most `size` items. */
export function inBatches<T>(items: Array<T>, size: number): Array<Array<T>> {
  const batches: Array<Array<T>> = [];
  for (let start = 0; start < items.length; start += size) {
    batches.push(items.slice(start, start + size));
  }
  return batches;
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
