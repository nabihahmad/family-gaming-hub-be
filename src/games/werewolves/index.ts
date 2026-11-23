import { requireRule, shuffle } from "../common.js";
import type { GameContext, GameEvent, GameModule, WerewolvesRole, WerewolvesState } from "../types.js";

const roleIds = new Set<WerewolvesRole>([
  "doppelganger",
  "werewolf",
  "minion",
  "mason",
  "seer",
  "robber",
  "troublemaker",
  "drunk",
  "insomniac",
  "villager",
  "hunter",
  "tanner",
]);
const roleLimits: Partial<Record<WerewolvesRole, number>> = { werewolf: 2, mason: 2 };
const nightOrder: WerewolvesRole[] = [
  "doppelganger",
  "werewolf",
  "minion",
  "mason",
  "seer",
  "robber",
  "troublemaker",
  "drunk",
  "insomniac",
];
const nightStepMs = 10_000;
const dayDurationMs = 5 * 60_000;
const voteDurationMs = 90_000;

function getState(state: unknown): WerewolvesState {
  return state as WerewolvesState;
}

function roleOptions(ctx: GameContext): WerewolvesRole[] {
  const playerCount = ctx.players.filter((player) => player.connected).length;
  const defaultRoles: WerewolvesRole[] = ["werewolf", "werewolf", "seer", "robber", "troublemaker", "villager"];
  const roles = (ctx.options.roles ?? defaultRoles).filter((role): role is WerewolvesRole =>
    roleIds.has(role as WerewolvesRole),
  );
  requireRule(
    roles.length === playerCount + 3,
    "INVALID_OPTIONS",
    `Werewolves needs exactly ${playerCount + 3} role cards for this room.`,
  );
  requireRule(
    roles.some((role) => role === "werewolf" || role === "minion"),
    "INVALID_OPTIONS",
    "Include at least one werewolf-team role.",
  );
  const counts = new Map<WerewolvesRole, number>();
  for (const role of roles) {
    const count = (counts.get(role) ?? 0) + 1;
    requireRule(
      count <= (role === "villager" ? playerCount + 3 : (roleLimits[role] ?? 1)),
      "INVALID_OPTIONS",
      "The role list contains too many copies of a role.",
    );
    counts.set(role, count);
  }
  return roles;
}

function resizeRoleDeck(roles: string[] | undefined, playerCount: number): WerewolvesRole[] {
  const deck = (roles ?? ["werewolf", "werewolf", "seer", "robber", "troublemaker", "villager"]).filter(
    (role): role is WerewolvesRole => roleIds.has(role as WerewolvesRole),
  );
  const required = playerCount + 3;
  while (deck.length < required) deck.push("villager");
  while (deck.length > required) {
    const villagerIndex = deck.lastIndexOf("villager");
    deck.splice(villagerIndex >= 0 ? villagerIndex : deck.length - 1, 1);
  }
  if (!deck.some((role) => role === "werewolf" || role === "minion")) deck[deck.length - 1] = "werewolf";
  return deck;
}

function connectedActors(state: WerewolvesState, role: WerewolvesRole, ctx: GameContext): string[] {
  return ctx.players.filter((player) => player.connected && state.roles[player.id] === role).map((player) => player.id);
}

function startStage(state: WerewolvesState, ctx: GameContext): void {
  const role = state.stages[state.stageIndex];
  if (!role) {
    state.phase = "day";
    state.dayEndsAt = ctx.now() + dayDurationMs;
    delete state.stageEndsAt;
    return;
  }
  state.stageEndsAt = ctx.now() + nightStepMs;
  if (role === "insomniac") {
    for (const playerId of connectedActors(state, role, ctx)) {
      state.acted.push(playerId);
      state.actions[playerId] = [{ target: playerId, role: state.roles[playerId]! }];
    }
  }
}

function advanceStageIfReady(state: WerewolvesState, ctx: GameContext): boolean {
  if (state.phase !== "night" || (state.stageEndsAt ?? Infinity) > ctx.now()) return false;
  const role = state.stages[state.stageIndex];
  const allActed = !role || connectedActors(state, role, ctx).every((id) => state.acted.includes(id));
  if (!allActed) return false;
  state.stageIndex++;
  startStage(state, ctx);
  return true;
}

function init(ctx: GameContext): WerewolvesState {
  const players = ctx.players.filter((player) => player.connected);
  requireRule(players.length >= 3 && players.length <= 10, "NOT_ENOUGH_PLAYERS", "Werewolves needs 3 to 10 players.");
  const roles = shuffle(roleOptions(ctx), ctx.rng);
  const originalRoles: Record<string, WerewolvesRole> = {};
  players.forEach((player, index) => {
    originalRoles[player.id] = roles[index]!;
  });
  const stages = nightOrder.filter((role) => roles.includes(role));
  return {
    game: "werewolves",
    phase: "role_reveal",
    originalRoles,
    roles: { ...originalRoles },
    center: roles.slice(players.length),
    acked: [],
    stages,
    stageIndex: 0,
    actions: {},
    acted: [],
    votes: {},
  };
}

function validTargets(targets: unknown): targets is string[] {
  return (
    Array.isArray(targets) &&
    targets.every((target) => typeof target === "string") &&
    new Set(targets).size === targets.length
  );
}

function applyNightAction(
  state: WerewolvesState,
  playerId: string,
  targets: string[],
  ctx: GameContext,
): Array<{ target: string; role: WerewolvesRole }> {
  const role = state.roles[playerId]!;
  const playerIds = new Set(ctx.players.map((player) => player.id));
  const others = new Set(ctx.players.filter((player) => player.id !== playerId).map((player) => player.id));
  const centerIds = new Set(state.center.map((_, index) => `center-${index}`));
  const selectedPlayers = targets.filter((target) => playerIds.has(target));
  const selectedCenters = targets.filter((target) => centerIds.has(target));
  requireRule(
    targets.every((target) => playerIds.has(target) || centerIds.has(target)),
    "INVALID_ACTION",
    "A target is not part of this game.",
  );

  if (role === "doppelganger") {
    requireRule(targets.length === 1 && others.has(targets[0]!), "INVALID_ACTION", "Choose another player.");
    const target = targets[0]!;
    const copied = state.roles[target]!;
    state.roles[playerId] = copied;
    return [{ target, role: copied }];
  }
  if (role === "werewolf") {
    const otherWolves = Object.entries(state.roles).filter(([id, value]) => id !== playerId && value === "werewolf");
    if (otherWolves.length) {
      requireRule(targets.length === 0, "INVALID_ACTION", "Werewolves with a teammate do not choose a card.");
      return [];
    }
    requireRule(targets.length === 1 && selectedCenters.length === 1, "INVALID_ACTION", "Choose one center card.");
    return [{ target: targets[0]!, role: state.center[Number(targets[0]!.slice("center-".length))]! }];
  }
  if (role === "minion" || role === "mason") {
    requireRule(targets.length === 0, "INVALID_ACTION", "This role has no target.");
    return [];
  }
  if (role === "seer") {
    if (targets.length === 1) {
      requireRule(selectedPlayers.length === 1 && others.has(targets[0]!), "INVALID_ACTION", "Choose another player.");
      return [{ target: targets[0]!, role: state.roles[targets[0]!]! }];
    }
    requireRule(
      targets.length === 2 && selectedCenters.length === 2,
      "INVALID_ACTION",
      "Choose one player or two center cards.",
    );
    return targets.map((target) => ({ target, role: state.center[Number(target.slice("center-".length))]! }));
  }
  if (role === "robber") {
    requireRule(targets.length === 1 && others.has(targets[0]!), "INVALID_ACTION", "Choose another player.");
    const target = targets[0]!;
    [state.roles[playerId], state.roles[target]] = [state.roles[target]!, state.roles[playerId]!];
    return [];
  }
  if (role === "troublemaker") {
    requireRule(
      targets.length === 2 && targets.every((target) => others.has(target)),
      "INVALID_ACTION",
      "Choose two other players.",
    );
    [state.roles[targets[0]!], state.roles[targets[1]!]] = [state.roles[targets[1]!]!, state.roles[targets[0]!]!];
    return [];
  }
  if (role === "drunk") {
    requireRule(targets.length === 1 && selectedCenters.length === 1, "INVALID_ACTION", "Choose one center card.");
    const index = Number(targets[0]!.slice("center-".length));
    [state.roles[playerId], state.center[index]] = [state.center[index]!, state.roles[playerId]!];
    return [];
  }
  requireRule(targets.length === 0, "INVALID_ACTION", "This role has no target.");
  return [];
}

function finishVote(state: WerewolvesState): void {
  const counts = new Map<string, number>();
  Object.values(state.votes).forEach((target) => counts.set(target, (counts.get(target) ?? 0) + 1));
  const highest = Math.max(0, ...counts.values());
  // Tied leaders all die; a dead Hunter also kills the player they voted for.
  const dead = new Set([...counts].filter(([, count]) => count === highest && highest > 0).map(([id]) => id));
  const pending = [...dead];
  while (pending.length) {
    const deadId = pending.pop()!;
    if (state.roles[deadId] !== "hunter") continue;
    const target = state.votes[deadId];
    if (target && !dead.has(target)) {
      dead.add(target);
      pending.push(target);
    }
  }
  if ([...dead].some((id) => state.roles[id] === "tanner")) state.winner = "tanner";
  else if ([...dead].some((id) => state.roles[id] === "werewolf")) state.winner = "village";
  else if (Object.values(state.roles).includes("werewolf")) state.winner = "werewolf";
  else state.winner = dead.size === 0 ? "village" : "werewolf";
  state.phase = "result";
  delete state.voteEndsAt;
}

function handle(value: unknown, playerId: string, event: GameEvent, ctx: GameContext): WerewolvesState {
  const state = getState(value);
  if (event.name === "ack_role") {
    requireRule(state.phase === "role_reveal", "INVALID_PHASE", "The role reveal has ended.");
    if (!state.acked.includes(playerId)) state.acked.push(playerId);
    const players = ctx.players.filter((player) => player.connected);
    if (players.every((player) => state.acked.includes(player.id))) {
      state.phase = "night";
      startStage(state, ctx);
    }
    return state;
  }
  if (event.name === "night_action") {
    requireRule(state.phase === "night", "INVALID_PHASE", "It is not night.");
    const role = state.stages[state.stageIndex];
    requireRule(role && state.roles[playerId] === role, "NOT_ALLOWED", "It is not your turn to act.");
    requireRule(!state.acted.includes(playerId), "INVALID_ACTION", "Your night action was already submitted.");
    const targets = event.data.targets;
    requireRule(validTargets(targets), "INVALID_ACTION", "Targets must be a list of player or center IDs.");
    state.actions[playerId] = applyNightAction(state, playerId, targets, ctx);
    state.acted.push(playerId);
    advanceStageIfReady(state, ctx);
    return state;
  }
  if (event.name === "end_day") {
    requireRule(state.phase === "day", "INVALID_PHASE", "The discussion phase has ended.");
    state.phase = "vote";
    state.voteEndsAt = ctx.now() + voteDurationMs;
    delete state.dayEndsAt;
    return state;
  }
  if (event.name === "end_game") {
    requireRule(state.phase === "day", "INVALID_PHASE", "The game can only be ended during the day.");
    state.phase = "result";
    delete state.dayEndsAt;
    return state;
  }
  if (event.name === "vote") {
    requireRule(state.phase === "vote", "INVALID_PHASE", "Voting is not open.");
    const target = event.data.target;
    requireRule(
      typeof target === "string" && target !== playerId && ctx.players.some((player) => player.id === target),
      "INVALID_ACTION",
      "Choose another player.",
    );
    state.votes[playerId] = target;
    const connected = ctx.players.filter((player) => player.connected);
    if (connected.every((player) => state.votes[player.id])) finishVote(state);
    return state;
  }
  if (event.name === "next_game") {
    requireRule(state.phase === "result", "INVALID_PHASE", "The current game is not finished.");
    const connectedCount = ctx.players.filter((player) => player.connected).length;
    return init({
      ...ctx,
      options: { ...ctx.options, roles: resizeRoleDeck(ctx.options.roles, connectedCount) },
    });
  }
  throw new Error("Unknown Werewolves action.");
}

function promptFor(
  state: WerewolvesState,
  playerId: string,
  players: GameContext["players"],
): Record<string, unknown> | undefined {
  const role = state.roles[playerId]!;
  const others = players.filter((player) => player.id !== playerId).map((player) => player.id);
  let prompt: Record<string, unknown>;
  if (role === "doppelganger") prompt = { kind: role, options: { players: others, min: 1, max: 1 } };
  else if (role === "werewolf") {
    const wolves = Object.entries(state.roles)
      .filter(([id, value]) => id !== playerId && value === "werewolf")
      .map(([id]) => id);
    prompt = wolves.length
      ? { kind: role, options: {}, info: wolves }
      : { kind: role, options: { center: 1, min: 1, max: 1 } };
  } else if (role === "minion") {
    prompt = {
      kind: role,
      options: {},
      info: Object.entries(state.roles)
        .filter(([, value]) => value === "werewolf")
        .map(([id]) => id),
    };
  } else if (role === "mason") {
    prompt = {
      kind: role,
      options: {},
      info: Object.entries(state.roles)
        .filter(([id, value]) => id !== playerId && value === "mason")
        .map(([id]) => id),
    };
  } else if (role === "seer") prompt = { kind: role, options: { players: others, center: 3, min: 1, max: 2 } };
  else if (role === "robber") prompt = { kind: role, options: { players: others, min: 1, max: 1 } };
  else if (role === "troublemaker") prompt = { kind: role, options: { players: others, min: 2, max: 2 } };
  else if (role === "drunk") prompt = { kind: role, options: { center: 3, min: 1, max: 1 } };
  else if (role === "insomniac") prompt = { kind: role, options: { players: [playerId], min: 0, max: 0 } };
  else return undefined;
  if (state.actions[playerId]) prompt.result = state.actions[playerId];
  return prompt;
}

function view(value: unknown, playerId: string, players: GameContext["players"], options: GameContext["options"]) {
  const state = getState(value);
  if (!state.originalRoles[playerId]) return null;
  const result: Record<string, unknown> = {
    phase: state.phase,
    lang: options.lang,
  };
  if (state.phase === "role_reveal") result.myRole = state.originalRoles[playerId];
  if (state.phase === "night") result.myRole = state.roles[playerId];
  if (state.phase === "role_reveal") result.acked = state.acked.includes(playerId);
  if (state.phase === "night" && state.stages[state.stageIndex] === state.roles[playerId]) {
    result.prompt = promptFor(state, playerId, players);
  }
  if (state.phase === "day" && state.dayEndsAt) result.endsAt = state.dayEndsAt;
  if (state.phase === "vote") {
    result.myVote = state.votes[playerId];
    result.votedCount = Object.keys(state.votes).length;
    result.totalPlayers = players.filter((player) => player.connected).length;
    if (state.voteEndsAt) result.endsAt = state.voteEndsAt;
  }
  if (state.phase === "result") {
    result.result = { roles: state.roles, votes: state.votes, winner: state.winner };
  }
  return { game: "werewolves", view: result };
}

function onTimer(value: unknown, ctx: GameContext): boolean {
  const state = getState(value);
  if (state.phase === "day" && (state.dayEndsAt ?? Infinity) <= ctx.now()) {
    state.phase = "vote";
    state.voteEndsAt = ctx.now() + voteDurationMs;
    delete state.dayEndsAt;
    return true;
  }
  if (state.phase === "night") return advanceStageIfReady(state, ctx);
  if (state.phase === "vote" && (state.voteEndsAt ?? Infinity) <= ctx.now()) {
    finishVote(state);
    return true;
  }
  return false;
}

export function validateWerewolvesOptions(roles: unknown, playerCount: number): asserts roles is string[] {
  requireRule(
    Array.isArray(roles) && roles.length === playerCount + 3,
    "INVALID_OPTIONS",
    `Werewolves needs exactly ${playerCount + 3} role cards.`,
  );
  requireRule(
    roles.every((role) => typeof role === "string" && roleIds.has(role as WerewolvesRole)),
    "INVALID_OPTIONS",
    "The role list contains an unknown role.",
  );
  requireRule(
    roles.some((role) => role === "werewolf" || role === "minion"),
    "INVALID_OPTIONS",
    "Include at least one werewolf-team role.",
  );
  const counts = new Map<string, number>();
  for (const role of roles) {
    const count = (counts.get(role) ?? 0) + 1;
    requireRule(
      count <= (role === "villager" ? playerCount + 3 : (roleLimits[role as WerewolvesRole] ?? 1)),
      "INVALID_OPTIONS",
      "The role list contains too many copies of a role.",
    );
    counts.set(role, count);
  }
}

export const werewolvesGame: GameModule = {
  id: "werewolves",
  minPlayers: 3,
  maxPlayers: 10,
  init,
  handle,
  view,
  onTimer,
};
