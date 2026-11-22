export type GameId = "codenames" | "imposter" | "werewolves";
export type Lang = "en" | "ar";

export interface Player {
  id: string;
  name: string;
  connected: boolean;
}

export interface GameOptions {
  lang: Lang;
  packs?: string[];
  imposters?: number;
  roles?: string[];
}

export interface RoomState {
  code: string;
  hostId: string;
  phase: "lobby" | "playing";
  game?: GameId;
  options?: GameOptions;
  players: Player[];
}

export interface CardWord {
  word: string;
  hint?: string | undefined;
}

export interface CardDocument {
  _id?: import("mongodb").ObjectId;
  games: GameId[];
  pack: string;
  active: boolean;
  en?: CardWord;
  ar?: CardWord;
  enNorm?: string;
  arNorm?: string;
  updatedAt?: Date;
}

export interface PackDocument {
  _id: string;
  name: Record<Lang, string>;
  games: GameId[];
  active: boolean;
}

export type ClientMessage =
  | {
      type: "join";
      payload: {
        roomCode: string;
        name: string;
        accessToken: string;
        playerId?: string;
        token?: string;
      };
    }
  | { type: "select_game"; payload: { game: GameId; options: GameOptions } }
  | { type: "start_game" | "back_to_lobby" | "ping"; payload: Record<string, never> }
  | { type: "game_event"; payload: { name: string; data?: Record<string, unknown> } };

export interface ServerMessage {
  type: "joined" | "room_state" | "game_view" | "error" | "pong";
  payload: unknown;
}
