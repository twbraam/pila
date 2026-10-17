import * as z from "zod/mini";
import { UpstreamError } from "../errors.js";

const probability = z.number().check(z.minimum(0), z.maximum(1));
const noulSchema = z.object({ type: z.literal("noul"), noul: probability });

/** Validate a `noul` answer from Jev. Throws `UpstreamError` on an unexpected shape. */
export function readNoul(answer: unknown, key: string): number {
  const parsed = noulSchema.safeParse(answer);
  if (!parsed.success) throw new UpstreamError(`Jev returned an unexpected answer for ${key}`, { service: "jev" });
  return parsed.data.noul;
}

/** Validate a `choice` answer and check the choice is one of `options`. */
export function readChoice<T extends string>(answer: unknown, key: string, options: readonly T[]) {
  const schema = z.object({ type: z.literal("choice"), choice: z.enum(options as [T, ...T[]]), confidence: probability });
  const parsed = schema.safeParse(answer);
  if (!parsed.success) throw new UpstreamError(`Jev returned an unexpected answer for ${key}`, { service: "jev" });
  return { choice: parsed.data.choice as T, confidence: parsed.data.confidence };
}
