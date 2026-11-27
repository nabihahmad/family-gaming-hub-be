import { describe, expect, it } from "vitest";
import { CardCache } from "../src/cards/cache.js";
import { normalizeWord } from "../src/cards/normalize.js";
import { selectCards, NotEnoughCardsError } from "../src/cards/selection.js";
import { getSeedCardGames } from "../src/cards/seed-utils.js";
import type { CardDocument, GameId, PackDocument } from "../src/protocol/types.js";

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

  it("uses the associated pack's game restrictions for every seeded card", () => {
    const packGames = new Map<string, GameId[]>([
      ["original-codenames", ["codenames"]],
      ["shared", ["codenames", "imposter"]],
    ]);

    expect(getSeedCardGames("original-codenames", packGames)).toEqual(["codenames"]);
    expect(getSeedCardGames("shared", packGames)).toEqual(["codenames", "imposter"]);
    expect(() => getSeedCardGames("missing-pack", packGames)).toThrow(/unknown pack/);
  });

  it("lists packs when a translation is missing", async () => {
    const packs: PackDocument[] = [
      { _id: "english-only", name: { en: "English Pack" }, games: ["codenames"], active: true },
      { _id: "arabic-only", name: { ar: "حزمة عربية" }, games: ["codenames"], active: true },
    ];
    const cache = new CardCache({
      loadActiveCards: async () => [],
      loadActivePacks: async () => packs,
    });
    await cache.refresh();

    for (const lang of ["en", "ar"] as const) {
      const listed = cache.listPacks("codenames", lang);
      expect(listed).toHaveLength(2);
      expect(listed.map(({ name }) => name)).toEqual(expect.arrayContaining(["English Pack", "حزمة عربية"]));
    }
  });
});
