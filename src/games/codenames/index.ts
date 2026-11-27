import { requireRule, shuffle } from "../common.js";
import type { CodenamesState, CodenamesTimerConfig, GameContext, GameEvent, GameModule } from "../types.js";

const teams = ["red", "blue"] as const;
type Team = (typeof teams)[number];
const defaultTimers: CodenamesTimerConfig = {
  spymasterInitialMs: 120_000,
  spymasterRoundDecrementMs: 15_000,
  spymasterMinimumMs: 15_000,
  guesserMsPerWord: 30_000,
};

function getState(state: unknown): CodenamesState {
  return state as CodenamesState;
}

function getTimers(ctx: GameContext): CodenamesTimerConfig {
  return ctx.codenamesTimers ?? defaultTimers;
}

function startSpymasterTimer(state: CodenamesState, ctx: GameContext): void {
  const timers = getTimers(ctx);
  const duration = Math.max(
    timers.spymasterMinimumMs,
    timers.spymasterInitialMs - state.spymasterTurns[state.turn] * timers.spymasterRoundDecrementMs,
  );
  state.turnEndsAt = ctx.now() + duration;
}

function startGuesserTimer(state: CodenamesState, clueNumber: number, ctx: GameContext): void {
  const timers = getTimers(ctx);
  const words = clueNumber === 0 ? state.remaining[state.turn] : clueNumber;
  state.turnEndsAt = ctx.now() + words * timers.guesserMsPerWord;
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
    spymasterTurns: { red: 0, blue: 0 },
    remaining: { red: 9, blue: 8 },
    clueLog: [],
    guessesMade: 0,
  };
}

function makeKey(state: CodenamesState, rng: () => number, ctx: GameContext): void {
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
  state.spymasterTurns = { red: 0, blue: 0 };
  state.remaining = first === "red" ? { red: 9, blue: 8 } : { red: 8, blue: 9 };
  state.guessesMade = 0;
  state.clueLog = [];
  delete state.clue;
  startSpymasterTimer(state, ctx);
  state.board.forEach((card, index) => {
    card.color = colors[index]!;
  });
}

type CardColor = "red" | "blue" | "neutral" | "assassin";

function endTurn(state: CodenamesState, ctx: GameContext): void {
  state.spymasterTurns[state.turn]++;
  state.turn = state.turn === "red" ? "blue" : "red";
  state.guessesMade = 0;
  delete state.clue;
  startSpymasterTimer(state, ctx);
}

function forfeitExpiredTurn(state: CodenamesState, ctx: GameContext): boolean {
  if (state.turnEndsAt === undefined || state.turnEndsAt > ctx.now()) return false;
  endTurn(state, ctx);
  return true;
}

function hasControlCharacters(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 32 || code === 127;
  });
}

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
    makeKey(state, ctx.rng, ctx);
    return state;
  }
  requireRule(state.phase === "playing", "INVALID_PHASE", "This action is not available now.");
  if (forfeitExpiredTurn(state, ctx)) return state;
  const team = teams.find((item) => state.teams[item].includes(playerId));
  const isSpymaster = Boolean(team && state.teams.spymasters[team] === playerId);
  if (name === "give_clue") {
    requireRule(team === state.turn && isSpymaster, "NOT_ALLOWED", "Only the active team's spymaster can give a clue.");
    requireRule(!state.clue, "INVALID_ACTION", "A clue has already been given for this turn.");
    requireRule(
      typeof data.text === "string" &&
        data.text.trim().length > 0 &&
        data.text.trim().length <= 80 &&
        !hasControlCharacters(data.text),
      "INVALID_ACTION",
      "Enter a clue between 1 and 80 characters without control characters.",
    );
    requireRule(
      Number.isInteger(data.number) && Number(data.number) >= 0 && Number(data.number) <= 25,
      "INVALID_ACTION",
      "The clue number must be between 0 and 25.",
    );
    state.clue = { team: state.turn, text: data.text.trim(), number: Number(data.number) };
    state.clueLog.push(state.clue);
    state.guessesMade = 0;
    startGuesserTimer(state, state.clue.number, ctx);
    return state;
  }
  if (name === "end_turn") {
    requireRule(
      team === state.turn && !isSpymaster && state.clue?.team === state.turn,
      "NOT_ALLOWED",
      "Only the active team's operatives can end the turn after a clue.",
    );
    endTurn(state, ctx);
    return state;
  }
  if (name === "reveal") {
    requireRule(
      team === state.turn && !isSpymaster && state.clue?.team === state.turn,
      "NOT_ALLOWED",
      "Only the active team's operatives can reveal a card after a clue.",
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
      delete state.turnEndsAt;
    } else if (card.color === "red" || card.color === "blue") {
      state.remaining[card.color]--;
      if (state.remaining[card.color] === 0) {
        state.phase = "finished";
        state.winner = card.color;
        delete state.turnEndsAt;
      } else if (card.color !== state.turn) {
        endTurn(state, ctx);
      } else {
        state.guessesMade++;
        if (state.clue.number > 0 && state.guessesMade >= state.clue.number + 1) endTurn(state, ctx);
      }
    } else {
      endTurn(state, ctx);
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
      clueLog: state.clueLog,
      remaining: state.remaining,
      ...(state.clue ? { clue: state.clue, guessesMade: state.guessesMade } : {}),
      ...(state.phase === "playing" && state.turnEndsAt !== undefined ? { endsAt: state.turnEndsAt } : {}),
      ...(state.winner ? { winner: state.winner } : {}),
    },
  };
}

function onTimer(value: unknown, ctx: GameContext): boolean {
  const state = getState(value);
  if (state.phase !== "playing") return false;
  return forfeitExpiredTurn(state, ctx);
}

export const codenamesGame: GameModule = {
  id: "codenames",
  minPlayers: 4,
  maxPlayers: 12,
  cardsNeeded: 25,
  init,
  handle,
  view,
  onTimer,
};
