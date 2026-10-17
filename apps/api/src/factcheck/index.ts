import { mockFactCheck } from "./mock.js";
import type { FactCheckFn } from "./provider.js";

export { type FactCheckFn, type FactCheckFnOptions, type FactCheckItem, parseFactCheckItems, type Score, SCORES } from "./provider.js";
export { mockFactCheck } from "./mock.js";

/**
 * Fact-check functions, selected with `FACTCHECK_SOURCE`. When the real one is ready, add it here
 * (for example `team: teamFactCheck`) and set `FACTCHECK_SOURCE=team`.
 */
export const factCheckProviders = { mock: mockFactCheck } as const satisfies Record<string, FactCheckFn>;

export type FactCheckSource = keyof typeof factCheckProviders;

export const isFactCheckSource = (value: string): value is FactCheckSource => Object.hasOwn(factCheckProviders, value);
