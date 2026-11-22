import { codenamesGame } from "./codenames/index.js";
import { imposterGame } from "./imposter/index.js";
import { werewolvesGame } from "./werewolves/index.js";
import type { GameId } from "../protocol/types.js";
import type { GameModule } from "./types.js";

export const gameRegistry: Record<GameId, GameModule> = {
  codenames: codenamesGame,
  imposter: imposterGame,
  werewolves: werewolvesGame,
};
