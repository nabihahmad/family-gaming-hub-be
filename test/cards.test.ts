import { describe, expect, it } from "vitest";
import { normalizeWord } from "../src/cards/normalize.js";
import { selectCards, NotEnoughCardsError } from "../src/cards/selection.js";
import type { CardDocument } from "../src/protocol/types.js";

describe("card normalization and selection", () => {
  it("normalizes Arabic only for comparison", () => {
    expect(normalizeWord("  أَكْلٌ ـ ", "ar")).toBe("اكل");
    expect(normalizeWord("مدرسة", "ar")).toBe(normalizeWord("مدرسه", "ar"));
    expect(normalizeWord("Hello  WORLD", "en")).toBe("hello world");
  });

  it("filters by game and language, removes duplicate concepts, and shuffles", () => {
    const cards: CardDocument[] = [
      { pack: "a", games: ["codenames"], active: true, en: { word: "Apple" } },
      { pack: "a", games: ["codenames"], active: true, en: { word: " apple " } },
      { pack: "a", games: ["imposter"], active: true, en: { word: "Bridge" } },
      { pack: "a", games: ["codenames"], active: true, ar: { word: "جسر" } },
    ];
    const chosen = selectCards(cards, "codenames", "en", 1, () => 0.5);
    expect(chosen).toHaveLength(1);
    expect(["Apple", " apple "]).toContain(chosen[0]?.word);
    expect(() => selectCards(cards, "codenames", "en", 2)).toThrow(NotEnoughCardsError);
  });
});
