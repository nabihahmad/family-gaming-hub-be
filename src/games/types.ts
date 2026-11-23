import type { CardWord, GameOptions, GameId, Player } from "../protocol/types.js";

export type CardColor = "red" | "blue" | "neutral" | "assassin";

export interface CodenamesState {
  game: "codenames";
  phase: "setup" | "playing" | "finished";
  teams: { red: string[]; blue: string[]; spymasters: Partial<Record<"red" | "blue", string>> };
  board: Array<{ word: string; color?: CardColor; revealed: boolean }>;
  turn: "red" | "blue";
  remaining: { red: number; blue: number };
  clue?: { team: "red" | "blue"; text: string; number: number };
  guessesMade: number;
  winner?: "red" | "blue";
}

export interface ImposterState {
  game: "imposter";
  phase: "reveal" | "discussion" | "result";
  word: string;
  hint?: string;
  cardPool: CardWord[];
  participants: string[];
  imposters: string[];
  ready: string[];
}

export type WerewolvesRole =
  | "doppelganger"
  | "werewolf"
  | "minion"
  | "mason"
  | "seer"
  | "robber"
  | "troublemaker"
  | "drunk"
  | "insomniac"
  | "villager"
  | "hunter"
  | "tanner";

export interface WerewolvesState {
  game: "werewolves";
  phase: "role_reveal" | "night" | "day" | "vote" | "result";
  originalRoles: Record<string, WerewolvesRole>;
  roles: Record<string, WerewolvesRole>;
  center: WerewolvesRole[];
  acked: string[];
  stages: WerewolvesRole[];
  stageIndex: number;
  stageEndsAt?: number;
  dayEndsAt?: number;
  voteEndsAt?: number;
  actions: Record<string, Array<{ target: string; role: WerewolvesRole }>>;
  acted: string[];
  votes: Record<string, string>;
  winner?: "village" | "werewolf" | "tanner";
}

export type GameState = CodenamesState | ImposterState | WerewolvesState;
export interface GameEvent {
  name: string;
  data: Record<string, unknown>;
}
export interface GameContext {
  players: Player[];
  options: GameOptions;
  cards: CardWord[];
  rng: () => number;
  now: () => number;
}
export interface GameModule {
  id: GameId;
  minPlayers: number;
  maxPlayers: number;
  cardsNeeded?: number;
  init(ctx: GameContext): GameState;
  handle(state: GameState, playerId: string, event: GameEvent, ctx: GameContext): GameState;
  view(state: GameState, playerId: string, players: Player[], options: GameOptions): unknown;
  onTimer?(state: GameState, ctx: GameContext): boolean;
}
