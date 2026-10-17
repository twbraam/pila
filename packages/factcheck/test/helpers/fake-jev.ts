import { json, type RecordedCall } from "./fake-fetch.js";

export const JEV = "https://api.typesafe.ai/v1/systemone";

interface Question {
  readonly type: "noul" | "choice";
  readonly instructions: string;
  readonly criteria?: Record<string, unknown>;
}

export interface JevRequestBody {
  readonly model: string;
  readonly state: unknown;
  readonly questions: Record<string, Question>;
}

export type Answer = { type: "noul"; noul: number } | { type: "choice"; choice: string; probabilities: Record<string, number>; confidence: number };

export const noulAnswer = (noul: number): Answer => ({ type: "noul", noul });

export const choiceAnswer = (choice: string, confidence: number, options: string[]): Answer => ({
  type: "choice",
  choice,
  confidence,
  probabilities: Object.fromEntries(options.map((o) => [o, o === choice ? confidence : (1 - confidence) / (options.length - 1)])),
});

/** Builds a Jev response by asking `answer` for every question in the request. */
export const jevResponder =
  (answer: (key: string, question: Question, body: JevRequestBody) => Answer, inputTokens = 100) =>
  (call: RecordedCall) => {
    const body = call.body as JevRequestBody;
    const answers = Object.fromEntries(Object.entries(body.questions).map(([key, q]) => [key, answer(key, q, body)]));
    return json({ model: "jev-1.13.0", answers, usage: { input_tokens: inputTokens, output_tokens: 1 } });
  };
