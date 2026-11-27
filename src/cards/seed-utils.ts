import type { GameId } from "../protocol/types.js";

export function getSeedCardGames(packId: string, packGames: ReadonlyMap<string, GameId[]>): GameId[] {
  const games = packGames.get(packId);
  if (!games) throw new Error(`Seed card references unknown pack "${packId}".`);
  return games;
}
