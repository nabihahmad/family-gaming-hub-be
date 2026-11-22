import { describe, expect, it } from "vitest";
import { codenamesGame } from "../src/games/codenames/index.js";
import { imposterGame } from "../src/games/imposter/index.js";
import { werewolvesGame } from "../src/games/werewolves/index.js";
import type { GameContext, WerewolvesState } from "../src/games/types.js";
import type { Player } from "../src/protocol/types.js";

const players: Player[] = [
  { id: "p1", name: "One", connected: true },
  { id: "p2", name: "Two", connected: true },
  { id: "p3", name: "Three", connected: true },
  { id: "p4", name: "Four", connected: true },
];

function context(
  options: GameContext["options"],
  playerList = players,
  cards: GameContext["cards"] = [],
  now: () => number = () => 1_000,
): GameContext {
  return { players: playerList, options, cards, rng: () => 0.999, now };
}

function event(name: string, data: Record<string, unknown> = {}) {
  return { name, data };
}

describe("Codenames", () => {
  it("starts with a valid board and hides the key from operatives", () => {
    const ctx = context(
      { lang: "en", packs: ["everyday"] },
      players,
      Array.from({ length: 25 }, (_, index) => ({ word: `word-${index}` })),
    );
    const state = codenamesGame.init(ctx);
    if (state.game !== "codenames") throw new Error("Unexpected game state.");

    for (const [playerId, team] of [
      ["p1", "red"],
      ["p2", "red"],
      ["p3", "blue"],
      ["p4", "blue"],
    ] as const) {
      codenamesGame.handle(state, playerId, event("set_team", { team }), ctx);
    }
    codenamesGame.handle(state, "p1", event("become_spymaster"), ctx);
    codenamesGame.handle(state, "p3", event("become_spymaster"), ctx);
    codenamesGame.handle(state, "p1", event("begin"), ctx);

    const operativeProjection = JSON.stringify(codenamesGame.view(state, "p2", players, ctx.options));
    const spymaster = codenamesGame.view(state, "p1", players, ctx.options);
    expect(operativeProjection).not.toContain('"color"');
    expect((spymaster as { view: { board: Array<{ color?: string }> } }).view.board.every((card) => card.color)).toBe(
      true,
    );

    const key = state.board.map((card) => card.color);
    expect(key.filter((color) => color === "assassin")).toHaveLength(1);
    expect(key.filter((color) => color === state.turn)).toHaveLength(9);
    expect(key.filter((color) => color === (state.turn === "red" ? "blue" : "red"))).toHaveLength(8);

    const firstTeam = state.turn;
    const operative = state.teams[firstTeam].find((id) => state.teams.spymasters[firstTeam] !== id)!;
    const ownCard = state.board.findIndex((card) => card.color === firstTeam);
    codenamesGame.handle(state, operative, event("reveal", { index: ownCard }), ctx);
    expect(state.remaining[firstTeam]).toBe(8);
    expect(() =>
      codenamesGame.handle(state, state.teams.spymasters[firstTeam]!, event("reveal", { index: 0 }), ctx),
    ).toThrow();
    codenamesGame.handle(state, operative, event("end_turn"), ctx);
    const nextTeam = state.turn;
    const nextOperative = state.teams[nextTeam].find((id) => state.teams.spymasters[nextTeam] !== id)!;
    const assassin = state.board.findIndex((card) => card.color === "assassin");
    codenamesGame.handle(state, nextOperative, event("reveal", { index: assassin }), ctx);
    expect(state.phase).toBe("finished");
    expect(state.winner).toBe(firstTeam);
  });
});

describe("Imposter", () => {
  it("does not reveal the word to imposters before the result", () => {
    const ctx = context({ lang: "en", packs: ["everyday"], imposters: 1 }, players.slice(0, 3), [
      { word: "secret word", hint: "a clue" },
    ]);
    const state = imposterGame.init(ctx);
    if (state.game !== "imposter") throw new Error("Unexpected game state.");
    const imposters = new Set(state.imposters);
    for (const player of players.slice(0, 3)) {
      const projection = JSON.stringify(imposterGame.view(state, player.id, ctx.players, ctx.options));
      expect(projection.includes("secret word")).toBe(!imposters.has(player.id));
    }

    for (const playerId of state.imposters) imposterGame.handle(state, playerId, event("ready"), ctx);
    for (const player of players.slice(0, 3)) {
      if (!state.imposters.includes(player.id)) imposterGame.handle(state, player.id, event("ready"), ctx);
    }
    expect(state.phase).toBe("discussion");
    imposterGame.handle(state, "p1", event("reveal_imposter"), ctx);
    expect(JSON.stringify(imposterGame.view(state, "p1", ctx.players, ctx.options))).toContain("secret word");
  });

  it("limits the imposter count to the configured fraction of the room", () => {
    const ctx = context({ lang: "en", packs: ["everyday"], imposters: 2 }, players.slice(0, 3), [
      { word: "secret word" },
    ]);
    expect(() => imposterGame.init(ctx)).toThrow();
  });
});

describe("Werewolves", () => {
  it("keeps roles private through reveal, night, day, and vote, then publishes final results", () => {
    let now = 1_000;
    const ctx = context(
      { lang: "en", roles: ["werewolf", "seer", "robber", "minion", "villager", "villager"] },
      players.slice(0, 3),
      [],
      () => now,
    );
    const state = werewolvesGame.init(ctx);
    if (state.game !== "werewolves") throw new Error("Unexpected game state.");
    expect(state.originalRoles.p1).toBe("werewolf");
    expect(state.originalRoles.p2).toBe("seer");
    expect(JSON.stringify(werewolvesGame.view(state, "p2", ctx.players, ctx.options))).not.toContain('"werewolf"');

    for (const player of ctx.players) werewolvesGame.handle(state, player.id, event("ack_role"), ctx);
    expect(state.phase).toBe("night");
    expect(JSON.stringify(werewolvesGame.view(state, "p2", ctx.players, ctx.options))).not.toContain('"prompt"');
    werewolvesGame.handle(state, "p1", event("night_action", { targets: ["center-0"] }), ctx);
    now += 10_000;
    werewolvesGame.onTimer?.(state, ctx);
    now += 10_000;
    werewolvesGame.onTimer?.(state, ctx);
    expect(state.stages[state.stageIndex]).toBe("seer");
    werewolvesGame.handle(state, "p2", event("night_action", { targets: ["p1"] }), ctx);
    now += 10_000;
    werewolvesGame.onTimer?.(state, ctx);
    expect(state.stages[state.stageIndex]).toBe("robber");
    werewolvesGame.handle(state, "p3", event("night_action", { targets: ["p1"] }), ctx);
    now += 10_000;
    werewolvesGame.onTimer?.(state, ctx);
    expect(state.phase).toBe("day");
    expect(JSON.stringify(werewolvesGame.view(state, "p2", ctx.players, ctx.options))).not.toContain('"werewolf"');

    werewolvesGame.handle(state, "p1", event("end_day"), ctx);
    expect(state.phase).toBe("vote");
    werewolvesGame.handle(state, "p1", event("vote", { target: "p2" }), ctx);
    expect(JSON.stringify(werewolvesGame.view(state, "p2", ctx.players, ctx.options))).not.toContain('"p2":"p2"');
    werewolvesGame.handle(state, "p2", event("vote", { target: "p1" }), ctx);
    werewolvesGame.handle(state, "p3", event("vote", { target: "p1" }), ctx);
    expect(state.phase).toBe("result");
    expect(JSON.stringify(werewolvesGame.view(state, "p2", ctx.players, ctx.options))).toContain('"roles"');
  });

  it("rejects malformed or out-of-turn actions", () => {
    const state = werewolvesGame.init(
      context(
        { lang: "en", roles: ["werewolf", "seer", "robber", "minion", "villager", "villager"] },
        players.slice(0, 3),
      ),
    );
    if (state.game !== "werewolves") throw new Error("Unexpected game state.");
    const typedState: WerewolvesState = state;
    expect(() =>
      werewolvesGame.handle(
        typedState,
        "p2",
        event("night_action", { targets: [] }),
        context(
          { lang: "en", roles: ["werewolf", "seer", "robber", "minion", "villager", "villager"] },
          players.slice(0, 3),
        ),
      ),
    ).toThrow();
  });
});
