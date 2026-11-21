import { postJson } from "./http.ts";

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

/** Sends one System One request. */
export function askJev<Answer = ChoiceAnswer>(
  client: JevClient,
  body: object,
): Promise<JevResponse<Answer>> {
  return postJson({ url: client.endpoint, apiKey: client.apiKey, body, service: "Jev" });
}
