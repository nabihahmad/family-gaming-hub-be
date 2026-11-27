import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { config } from "../config.js";
import { connectCardRepository } from "./repo.js";
import { getSeedCardGames } from "./seed-utils.js";
import { normalizeWord } from "./normalize.js";
import type { CardDocument, CardWord, PackDocument } from "../protocol/types.js";

interface SeedCard {
  pack: string;
  en?: CardWord;
  ar?: CardWord;
}
interface SeedData {
  packs: PackDocument[];
  cards: SeedCard[];
}

async function seed(): Promise<void> {
  const repository = await connectCardRepository(config.mongoUri, config.mongoDb);
  try {
    const data = JSON.parse(await readFile(resolve(process.cwd(), "seed/cards.json"), "utf8")) as SeedData;
    const packGames = new Map(data.packs.map((pack) => [pack._id, pack.games]));
    for (const item of data.cards) getSeedCardGames(item.pack, packGames);

    for (const pack of data.packs) {
      await repository.packs.updateOne({ _id: pack._id }, { $set: pack }, { upsert: true });
    }
    let upserted = 0;
    for (const item of data.cards) {
      const card: CardDocument = {
        pack: item.pack,
        games: getSeedCardGames(item.pack, packGames),
        active: true,
        updatedAt: new Date(),
      };
      if (item.en) {
        card.en = item.en;
        card.enNorm = normalizeWord(item.en.word, "en");
      }
      if (item.ar) {
        card.ar = item.ar;
        card.arNorm = normalizeWord(item.ar.word, "ar");
      }
      if (!card.enNorm && !card.arNorm) throw new Error("Seed card needs at least one language.");
      const filter = card.enNorm ? { enNorm: card.enNorm } : { arNorm: card.arNorm! };
      await repository.cards.updateOne(filter, { $set: card }, { upsert: true });
      upserted++;
    }
    console.log(`Seeded ${data.packs.length} packs and ${upserted} cards.`);
  } finally {
    await repository.close();
  }
}

seed().catch(() => {
  console.error("Card seeding failed.");
  process.exitCode = 1;
});
