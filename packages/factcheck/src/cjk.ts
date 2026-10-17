/** CJK Unified Ideographs (with Extension A) and compatibility ideographs. Shared so all checks agree. */
const CJK_CLASS = "[㐀-鿿豈-﫿]";

/** Matches text that contains a CJK character. */
export const HAS_CJK = new RegExp(CJK_CLASS);

/** Counts the CJK characters in a string. */
export const countCjk = (text: string): number => text.match(new RegExp(CJK_CLASS, "g"))?.length ?? 0;
