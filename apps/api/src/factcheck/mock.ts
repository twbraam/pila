import type { FactCheckFn, FactCheckItem } from "./provider.js";

/**
 * Fixed results for the mock transcript (the PragerU Lindzen video), so the extension team can
 * build against the real response shape. Sentences and sources come from earlier live runs of
 * `@pila/factcheck` on this video; the scores are made up.
 */
const MOCK_ITEMS: readonly FactCheckItem[] = [
  {
    timestamp: 7.88,
    sentence: "For 30 years I taught at MIT, during which time the climate has changed remarkably little.",
    score: 3,
    sources: ["https://science.feedback.org/review/video-from-prageru-makes-several-incorrect-and-misleading-claims-about-climate-change-richard-lindzen"],
  },
  {
    timestamp: 104.71,
    sentence: "None of these is fully understood, and there is no evidence that CO2 emissions are the dominant factor.",
    score: 3,
    sources: [
      "https://climatefeedback.org/evaluation/video-from-prageru-makes-several-incorrect-and-misleading-claims-about-climate-change-richard-lindzen",
      "https://www.distilled.earth/p/how-a-nonprofit-spread-climate-misinformation",
    ],
  },
  {
    timestamp: 134.89,
    sentence: "3) Atmospheric levels of CO2 have been increasing since the end of the Little Ice Age in the 19th century.",
    score: 0,
    sources: ["https://skepticalscience.com/co2-levels-airborne-fraction-increasing.htm", "https://science.nasa.gov/earth/explore/earth-indicators/carbon-dioxide"],
  },
  {
    timestamp: 174.53,
    sentence: "The IPCC acknowledged in its own 2007 report that “The long-term prediction of future climate states is not possible.”",
    score: 2,
    sources: ["https://climatefeedback.org/claimreview/prageru-post-by-william-happer-uses-flawed-reasoning-to-claim-that-climate-models-always-fail"],
  },
  {
    timestamp: 187.16,
    sentence: "Most importantly, the scenario that the burning of fossil fuel leads to catastrophe isn’t part of what either group asserts.",
    score: 1,
    sources: [],
  },
];

/** Stand-in for the real fact-check function: the same items for any transcript. */
export const mockFactCheck: FactCheckFn = async (_transcript, options = {}) => {
  options.signal?.throwIfAborted();
  return MOCK_ITEMS;
};
