import { normalizeWord } from "./normalize.js";
import type { CardDocument, CardWord, GameId, Lang } from "../protocol/types.js";

export class NotEnoughCardsError extends Error {
  constructor() {
    super("Not enough cards are available for the selected packs.");
    this.name = "NotEnoughCardsError";
  }
}

export function selectCards(
  cards: CardDocument[],
  game: GameId,
  lang: Lang,
  count: number,
  random = Math.random,
): CardWord[] {
  const candidates = cards.filter((card) => card.games.includes(game) && card[lang]?.word);
  const seen = new Set<string>();
  const unique = candidates.filter((card) => {
    const norm = normalizeWord(card[lang]!.word, lang);
    if (seen.has(norm)) return false;
    seen.add(norm);
    return true;
  });
  for (let i = unique.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [unique[i], unique[j]] = [unique[j]!, unique[i]!];
  }
  if (unique.length < count) throw new NotEnoughCardsError();
  return unique.slice(0, count).map((card) => card[lang]!);
}
