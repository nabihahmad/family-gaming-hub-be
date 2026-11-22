import { requireRule, shuffle } from "../common.js";
import type { CodenamesState, GameContext, GameEvent, GameModule } from "../types.js";

const teams = ["red", "blue"] as const;
type Team = (typeof teams)[number];

function getState(state: unknown): CodenamesState {
  return state as CodenamesState;
}

function init(ctx: GameContext): CodenamesState {
  requireRule(ctx.cards.length >= 25, "NOT_ENOUGH_CARDS", "Codenames needs 25 distinct cards.");
  return {
    game: "codenames",
    phase: "setup",
    teams: { red: [], blue: [], spymasters: {} },
    board: shuffle(ctx.cards, ctx.rng)
      .slice(0, 25)
      .map(({ word }) => ({ word, revealed: false })),
    turn: "red",
    remaining: { red: 9, blue: 8 },
  };
}

function makeKey(state: CodenamesState, rng: () => number): void {
  const first: Team = rng() < 0.5 ? "red" : "blue";
  const second: Team = first === "red" ? "blue" : "red";
  const colors = shuffle<CardColor>(
    [
      ...Array<CardColor>(9).fill(first),
      ...Array<CardColor>(8).fill(second),
      ...Array<CardColor>(7).fill("neutral"),
      "assassin",
    ],
    rng,
  );
  state.turn = first;
  state.remaining = first === "red" ? { red: 9, blue: 8 } : { red: 8, blue: 9 };
  state.board.forEach((card, index) => {
    card.color = colors[index]!;
  });
}

type CardColor = "red" | "blue" | "neutral" | "assassin";

function handle(value: unknown, playerId: string, event: GameEvent, ctx: GameContext): CodenamesState {
  const state = getState(value);
  const { name, data } = event;
  if (name === "set_team") {
    requireRule(state.phase === "setup", "INVALID_PHASE", "Teams are locked after the game begins.");
    requireRule(data.team === "red" || data.team === "blue", "INVALID_ACTION", "Choose a valid team.");
    for (const team of teams) {
      state.teams[team] = state.teams[team].filter((id) => id !== playerId);
      if (state.teams.spymasters[team] === playerId) delete state.teams.spymasters[team];
    }
    state.teams[data.team].push(playerId);
    return state;
  }
  if (name === "become_spymaster") {
    requireRule(state.phase === "setup", "INVALID_PHASE", "The game has already begun.");
    const team = teams.find((item) => state.teams[item].includes(playerId));
    requireRule(team, "INVALID_ACTION", "Join a team before becoming its spymaster.");
    requireRule(!state.teams.spymasters[team], "INVALID_ACTION", "That team already has a spymaster.");
    state.teams.spymasters[team] = playerId;
    return state;
  }
  if (name === "begin") {
    requireRule(
      ctx.players.some((player) => player.id === playerId),
      "INVALID_ACTION",
      "Player not found.",
    );
    requireRule(state.phase === "setup", "INVALID_PHASE", "The game has already begun.");
    for (const team of teams) {
      const spymaster = state.teams.spymasters[team];
      requireRule(spymaster && state.teams[team].includes(spymaster), "NOT_READY", "Each team needs a spymaster.");
      requireRule(
        state.teams[team].some((id) => id !== spymaster),
        "NOT_READY",
        "Each team needs an operative.",
      );
    }
    state.phase = "playing";
    makeKey(state, ctx.rng);
    return state;
  }
  requireRule(state.phase === "playing", "INVALID_PHASE", "This action is not available now.");
  const team = teams.find((item) => state.teams[item].includes(playerId));
  const isSpymaster = Boolean(team && state.teams.spymasters[team] === playerId);
  if (name === "end_turn") {
    requireRule(
      team === state.turn && !isSpymaster,
      "NOT_ALLOWED",
      "Only the active team's operatives can end the turn.",
    );
    state.turn = state.turn === "red" ? "blue" : "red";
    return state;
  }
  if (name === "reveal") {
    requireRule(
      team === state.turn && !isSpymaster,
      "NOT_ALLOWED",
      "Only the active team's operatives can reveal a card.",
    );
    requireRule(
      Number.isInteger(data.index) && Number(data.index) >= 0 && Number(data.index) < 25,
      "INVALID_ACTION",
      "Choose a valid card.",
    );
    const card = state.board[Number(data.index)]!;
    requireRule(!card.revealed, "INVALID_ACTION", "That card has already been revealed.");
    card.revealed = true;
    if (card.color === "assassin") {
      state.phase = "finished";
      state.winner = state.turn === "red" ? "blue" : "red";
    } else if (card.color === "red" || card.color === "blue") {
      state.remaining[card.color]--;
      if (state.remaining[card.color] === 0) {
        state.phase = "finished";
        state.winner = card.color;
      } else if (card.color !== state.turn) {
        state.turn = state.turn === "red" ? "blue" : "red";
      }
    } else {
      state.turn = state.turn === "red" ? "blue" : "red";
    }
    return state;
  }
  throw new Error("Unknown Codenames action.");
}

function view(value: unknown, playerId: string, _players: GameContext["players"], options: GameContext["options"]) {
  const state = getState(value);
  const myTeam = teams.find((team) => state.teams[team].includes(playerId));
  const isSpymaster = Boolean(myTeam && state.teams.spymasters[myTeam] === playerId);
  return {
    game: "codenames",
    view: {
      phase: state.phase,
      lang: options.lang,
      teams: state.teams,
      ...(myTeam ? { myTeam } : {}),
      isSpymaster,
      board: state.board.map((card) => ({
        word: card.word,
        revealed: card.revealed,
        ...((card.revealed || isSpymaster) && card.color ? { color: card.color } : {}),
      })),
      turn: state.turn,
      remaining: state.remaining,
      ...(state.winner ? { winner: state.winner } : {}),
    },
  };
}

export const codenamesGame: GameModule = {
  id: "codenames",
  minPlayers: 4,
  maxPlayers: 12,
  cardsNeeded: 25,
  init,
  handle,
  view,
};
