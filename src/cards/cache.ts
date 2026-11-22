import type { CardDocument, GameId, Lang, PackDocument } from "../protocol/types.js";

export interface CardSource {
  loadActiveCards: () => Promise<CardDocument[]>;
  loadActivePacks: () => Promise<PackDocument[]>;
}

export class CardCache {
  private cards: CardDocument[] = [];
  private packs: PackDocument[] = [];
  private ready = false;

  constructor(private readonly repository: CardSource) {}

  async refresh(): Promise<boolean> {
    try {
      const [cards, packs] = await Promise.all([this.repository.loadActiveCards(), this.repository.loadActivePacks()]);
      this.cards = cards;
      this.packs = packs;
      this.ready = true;
      return true;
    } catch (error) {
      if (!this.ready) throw error;
      console.warn("Card cache refresh failed; continuing with the previous cache.");
      return false;
    }
  }

  listPacks(game: "codenames" | "imposter", lang: Lang): Array<{ id: string; name: string; count: number }> {
    this.assertReady();
    return this.packs
      .filter((pack) => pack.games.includes(game))
      .map((pack) => ({
        id: pack._id,
        name: pack.name[lang],
        count: this.cards.filter((card) => card.pack === pack._id && card.games.includes(game) && Boolean(card[lang]))
          .length,
      }))
      .sort((a, b) => a.name.localeCompare(b.name, lang));
  }

  select(game: GameId, lang: Lang, packIds: string[]): CardDocument[] {
    this.assertReady();
    const activePacks = new Set(this.packs.filter((pack) => pack.games.includes(game)).map((pack) => pack._id));
    return this.cards.filter(
      (card) =>
        card.games.includes(game) && packIds.includes(card.pack) && activePacks.has(card.pack) && Boolean(card[lang]),
    );
  }

  allCards(): CardDocument[] {
    this.assertReady();
    return this.cards;
  }

  allPacks(): PackDocument[] {
    this.assertReady();
    return this.packs;
  }

  private assertReady(): void {
    if (!this.ready) throw new Error("Card cache has not been initialized.");
  }
}
