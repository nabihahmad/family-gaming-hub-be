import { pick, requireRule, shuffle } from "../common.js";
import type { GameContext, GameEvent, GameModule, ImposterState } from "../types.js";

function getState(state: unknown): ImposterState {
  return state as ImposterState;
}

function deal(state: ImposterState, playerIds: string[], impostersCount: number, rng: () => number): void {
  const card = pick(state.cardPool, rng);
  state.word = card.word;
  if (card.hint) state.hint = card.hint;
  else delete state.hint;
  state.participants = [...playerIds];
  state.imposters = shuffle(playerIds, rng).slice(0, impostersCount);
  state.ready = [];
  state.phase = "reveal";
}

function init(ctx: GameContext): ImposterState {
  const playerIds = ctx.players.filter((player) => player.connected).map((player) => player.id);
  const imposters = ctx.options.imposters ?? 1;
  requireRule(playerIds.length >= 3, "NOT_ENOUGH_PLAYERS", "Imposter needs at least 3 players.");
  requireRule(
    imposters <= Math.min(3, Math.max(1, Math.floor((playerIds.length - 1) / 2))),
    "INVALID_OPTIONS",
    "There are too many imposters for this room.",
  );
  requireRule(
    imposters < playerIds.length,
    "INVALID_OPTIONS",
    "There must be at least one player who is not an imposter.",
  );
  requireRule(ctx.cards.length > 0, "NOT_ENOUGH_CARDS", "No Imposter cards are available.");
  const state: ImposterState = {
    game: "imposter",
    phase: "reveal",
    word: "",
    cardPool: ctx.cards,
    participants: [],
    imposters: [],
    ready: [],
  };
  deal(state, playerIds, imposters, ctx.rng);
  return state;
}

function handle(value: unknown, playerId: string, event: GameEvent, ctx: GameContext): ImposterState {
  const state = getState(value);
  const connectedPlayers = ctx.players.filter((player) => player.connected && state.participants.includes(player.id));
  if (event.name === "ready") {
    requireRule(state.phase === "reveal", "INVALID_PHASE", "The reveal phase has ended.");
    requireRule(
      connectedPlayers.some((player) => player.id === playerId),
      "NOT_ALLOWED",
      "Only connected players can mark ready.",
    );
    if (!state.ready.includes(playerId)) state.ready.push(playerId);
    if (connectedPlayers.every((player) => state.ready.includes(player.id))) state.phase = "discussion";
    return state;
  }
  if (event.name === "reveal_imposter") {
    requireRule(state.phase === "discussion", "INVALID_PHASE", "The discussion phase has not started.");
    state.phase = "result";
    return state;
  }
  if (event.name === "next_round") {
    requireRule(state.phase === "result", "INVALID_PHASE", "The current round is not finished.");
    const imposters = ctx.options.imposters ?? 1;
    requireRule(connectedPlayers.length >= 3, "NOT_ENOUGH_PLAYERS", "Imposter needs at least 3 players.");
    requireRule(
      imposters <= Math.min(3, Math.max(1, Math.floor((connectedPlayers.length - 1) / 2))),
      "INVALID_OPTIONS",
      "There are too many imposters for this room.",
    );
    deal(
      state,
      connectedPlayers.map((player) => player.id),
      imposters,
      ctx.rng,
    );
    return state;
  }
  throw new Error("Unknown Imposter action.");
}

function view(value: unknown, playerId: string, players: GameContext["players"], options: GameContext["options"]) {
  const state = getState(value);
  if (!state.participants.includes(playerId)) return null;
  const isImposter = state.imposters.includes(playerId);
  const visiblePlayers = players.filter((player) => player.connected && state.participants.includes(player.id));
  const result =
    state.phase === "result"
      ? {
          imposters: state.imposters
            .map((id) => players.find((player) => player.id === id)?.name)
            .filter((name): name is string => Boolean(name)),
          word: state.word,
        }
      : undefined;
  return {
    game: "imposter",
    view: {
      phase: state.phase,
      lang: options.lang,
      isImposter,
      ...(!isImposter ? { word: state.word } : {}),
      ...(state.hint ? { hint: state.hint } : {}),
      readyCount: state.ready.filter((id) => visiblePlayers.some((player) => player.id === id)).length,
      totalPlayers: visiblePlayers.length,
      iAmReady: state.ready.includes(playerId),
      ...(result ? { result } : {}),
    },
  };
}

export const imposterGame: GameModule = {
  id: "imposter",
  minPlayers: 3,
  maxPlayers: 12,
  cardsNeeded: 1,
  init,
  handle,
  view,
};
