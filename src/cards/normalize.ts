import type { Lang } from "../protocol/types.js";

export function normalizeWord(word: string, lang: Lang): string {
  const collapsed = word.trim().toLocaleLowerCase().replace(/\s+/g, " ");
  if (lang === "en") return collapsed;
  return collapsed
    .replace(/[\u064B-\u065F\u0670\u06D6-\u06ED]/g, "")
    .replace(/\u0640/g, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .trim();
}
