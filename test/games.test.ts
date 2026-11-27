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

function startCodenames(ctx: GameContext) {
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
  return state;
}

describe("Codenames", () => {
  it("starts with a valid board and hides the key from operatives", () => {
    const ctx = context(
      { lang: "en", packs: ["everyday"] },
      players,
      Array.from({ length: 25 }, (_, index) => ({ word: `word-${index}` })),
    );
    const state = startCodenames(ctx);

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
    expect(() => codenamesGame.handle(state, operative, event("reveal", { index: ownCard }), ctx)).toThrow();
    codenamesGame.handle(
      state,
      state.teams.spymasters[firstTeam]!,
      event("give_clue", { text: "river", number: 1 }),
      ctx,
    );
    expect(codenamesGame.view(state, "p2", players, ctx.options)).toMatchObject({
      view: {
        clue: { team: firstTeam, text: "river", number: 1 },
        clueLog: [{ team: firstTeam, text: "river", number: 1 }],
        guessesMade: 0,
      },
    });
    codenamesGame.handle(state, operative, event("reveal", { index: ownCard }), ctx);
    expect(state.remaining[firstTeam]).toBe(8);
    expect(() =>
      codenamesGame.handle(state, state.teams.spymasters[firstTeam]!, event("reveal", { index: 0 }), ctx),
    ).toThrow();
    codenamesGame.handle(state, operative, event("end_turn"), ctx);
    const nextTeam = state.turn;
    const nextOperative = state.teams[nextTeam].find((id) => state.teams.spymasters[nextTeam] !== id)!;
    const assassin = state.board.findIndex((card) => card.color === "assassin");
    codenamesGame.handle(
      state,
      state.teams.spymasters[nextTeam]!,
      event("give_clue", { text: "danger", number: 1 }),
      ctx,
    );
    codenamesGame.handle(state, nextOperative, event("reveal", { index: assassin }), ctx);
    expect(state.phase).toBe("finished");
    expect(state.winner).toBe(firstTeam);
    expect(codenamesGame.view(state, "p2", players, ctx.options)).toMatchObject({
      view: {
        clueLog: [
          { team: firstTeam, text: "river", number: 1 },
          { team: nextTeam, text: "danger", number: 1 },
        ],
      },
    });
  });

  it("uses configured spymaster and guesser timers and forfeits expired turns", () => {
    let now = 1_000;
    const ctx = context(
      { lang: "en", packs: ["everyday"] },
      players,
      Array.from({ length: 25 }, (_, index) => ({ word: `word-${index}` })),
      () => now,
    );
    ctx.codenamesTimers = {
      spymasterInitialMs: 120_000,
      spymasterRoundDecrementMs: 15_000,
      spymasterMinimumMs: 15_000,
      guesserMsPerWord: 30_000,
    };
    const state = startCodenames(ctx);
    const firstTeam = state.turn;
    expect(state.turnEndsAt).toBe(now + 120_000);

    now += 119_999;
    expect(codenamesGame.onTimer?.(state, ctx)).toBe(false);
    now += 1;
    expect(codenamesGame.onTimer?.(state, ctx)).toBe(true);
    expect(state.turn).not.toBe(firstTeam);
    expect(state.turnEndsAt).toBe(now + 120_000);

    const guessTeam = state.turn;
    codenamesGame.handle(
      state,
      state.teams.spymasters[guessTeam]!,
      event("give_clue", { text: "three", number: 3 }),
      ctx,
    );
    expect(state.turnEndsAt).toBe(now + 90_000);
    now += 90_000;
    expect(codenamesGame.onTimer?.(state, ctx)).toBe(true);
    expect(state.turn).not.toBe(guessTeam);
    expect(state.turnEndsAt).toBe(now + 105_000);
  });

  it("bases unlimited-clue time on the active team's remaining words", () => {
    const ctx = context(
      { lang: "en", packs: ["everyday"] },
      players,
      Array.from({ length: 25 }, (_, index) => ({ word: `word-${index}` })),
    );
    ctx.codenamesTimers = {
      spymasterInitialMs: 120_000,
      spymasterRoundDecrementMs: 15_000,
      spymasterMinimumMs: 15_000,
      guesserMsPerWord: 30_000,
    };
    const state = startCodenames(ctx);
    const activeTeam = state.turn;
    codenamesGame.handle(
      state,
      state.teams.spymasters[activeTeam]!,
      event("give_clue", { text: "unlimited", number: 0 }),
      ctx,
    );
    expect(state.turnEndsAt).toBe(ctx.now() + state.remaining[activeTeam] * 30_000);
  });

  it("allows one extra guess after a numbered clue and treats zero as unlimited", () => {
    const ctx = context(
      { lang: "en", packs: ["everyday"] },
      players,
      Array.from({ length: 25 }, (_, index) => ({ word: `word-${index}` })),
    );
    const state = startCodenames(ctx);
    const team = state.turn;
    const spymaster = state.teams.spymasters[team]!;
    const operative = state.teams[team].find((id) => id !== spymaster)!;
    const ownCards = state.board.flatMap((card, index) => (card.color === team ? [index] : []));

    const inactiveSpymaster = state.teams.spymasters[team === "red" ? "blue" : "red"]!;
    expect(() =>
      codenamesGame.handle(state, inactiveSpymaster, event("give_clue", { text: "early", number: 1 }), ctx),
    ).toThrow();
    codenamesGame.handle(state, spymaster, event("give_clue", { text: "first clue", number: 1 }), ctx);
    codenamesGame.handle(state, operative, event("reveal", { index: ownCards[0] }), ctx);
    expect(state.guessesMade).toBe(1);
    codenamesGame.handle(state, operative, event("reveal", { index: ownCards[1] }), ctx);
    expect(state.turn).not.toBe(team);
    expect(state.clue).toBeUndefined();
    expect(() => codenamesGame.handle(state, operative, event("reveal", { index: ownCards[2] }), ctx)).toThrow();

    const nextTeam = state.turn;
    const nextSpymaster = state.teams.spymasters[nextTeam]!;
    const nextOperative = state.teams[nextTeam].find((id) => id !== nextSpymaster)!;
    const nextOwnCards = state.board.flatMap((card, index) => (card.color === nextTeam ? [index] : []));
    codenamesGame.handle(state, nextSpymaster, event("give_clue", { text: "unlimited", number: 0 }), ctx);
    codenamesGame.handle(state, nextOperative, event("reveal", { index: nextOwnCards[0] }), ctx);
    codenamesGame.handle(state, nextOperative, event("reveal", { index: nextOwnCards[1] }), ctx);
    expect(state.turn).toBe(nextTeam);
    expect(state.guessesMade).toBe(2);
    codenamesGame.handle(state, nextOperative, event("end_turn"), ctx);
    expect(state.turn).not.toBe(nextTeam);
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
  it("omits night discoveries from every player's view when the host disables them", () => {
    const ctx = context(
      {
        lang: "en",
        roles: ["werewolf", "seer", "robber", "villager", "villager", "villager"],
        nightDiscoveries: false,
      },
      players.slice(0, 3),
    );
    const state = werewolvesGame.init(ctx);
    if (state.game !== "werewolves") throw new Error("Unexpected game state.");
    state.phase = "day";
    state.privateResults.p1 = [{ kind: "seer", cards: [{ target: "center-0", role: "werewolf" }] }];

    for (const player of ctx.players) {
      expect(werewolvesGame.view(state, player.id, ctx.players, ctx.options)).not.toHaveProperty("view.privateResults");
    }
    expect(
      werewolvesGame.view(state, "p1", ctx.players, {
        ...ctx.options,
        nightDiscoveries: true,
      }),
    ).toMatchObject({
      view: { privateResults: [{ kind: "seer" }] },
    });
  });

  it("shows all three center cards to a solo Werewolf and accepts one choice", () => {
    const ctx = context(
      { lang: "en", roles: ["werewolf", "villager", "villager", "villager", "villager", "villager"] },
      players.slice(0, 3),
    );
    const state = werewolvesGame.init(ctx);
    if (state.game !== "werewolves") throw new Error("Unexpected game state.");
    state.phase = "night";
    state.stages = ["werewolf"];
    state.stageIndex = 0;
    state.stageActors = ["p1"];
    state.originalRoles = { p1: "werewolf", p2: "villager", p3: "villager" };
    state.roles = { ...state.originalRoles };

    expect(state.center).toHaveLength(3);
    expect(werewolvesGame.view(state, "p1", ctx.players, ctx.options)).toMatchObject({
      view: { prompt: { kind: "werewolf", options: { center: 3, min: 1, max: 1 } } },
    });

    werewolvesGame.handle(state, "p1", event("night_action", { targets: ["center-2"] }), ctx);
    expect(state.privateResults.p1).toEqual([
      { kind: "werewolf", cards: [{ target: "center-2", role: state.center[2] }] },
    ]);
  });

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
    expect(werewolvesGame.view(state, "p2", ctx.players, ctx.options)).not.toHaveProperty("view.availableRoles");
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
    expect(werewolvesGame.view(state, "p2", ctx.players, ctx.options)).toMatchObject({
      view: {
        privateResults: [{ kind: "seer", cards: [{ target: "p1", role: "werewolf" }] }],
        availableRoles: [
          { role: "werewolf", count: 1 },
          { role: "minion", count: 1 },
          { role: "seer", count: 1 },
          { role: "robber", count: 1 },
          { role: "villager", count: 2 },
        ],
      },
    });
    expect(JSON.stringify(werewolvesGame.view(state, "p2", ctx.players, ctx.options))).not.toContain(
      '"target":"p3","role":"werewolf"',
    );

    werewolvesGame.handle(state, "p1", event("end_day"), ctx);
    expect(state.phase).toBe("vote");
    expect(state.voteEndsAt).toBe(now + 10_000);
    expect(JSON.stringify(werewolvesGame.view(state, "p2", ctx.players, ctx.options))).not.toContain('"roles"');
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

  it("allows only the original Robber to act after stealing a role card", () => {
    let now = 1_000;
    const ctx = context(
      { lang: "en", roles: ["werewolf", "seer", "robber", "villager", "villager", "villager"] },
      players.slice(0, 3),
      [],
      () => now,
    );
    const state = werewolvesGame.init(ctx);
    if (state.game !== "werewolves") throw new Error("Unexpected game state.");
    state.phase = "night";
    state.stages = ["robber", "troublemaker"];
    state.stageIndex = 0;
    state.stageActors = ["p1"];
    state.stageEndsAt = now + 10_000;
    state.roles = { p1: "robber", p2: "villager", p3: "seer" };

    werewolvesGame.handle(state, "p1", event("night_action", { targets: ["p2"] }), ctx);

    expect(state.roles).toEqual({ p1: "villager", p2: "robber", p3: "seer" });
    expect(JSON.stringify(werewolvesGame.view(state, "p2", ctx.players, ctx.options))).not.toContain('"prompt"');
    expect(() => werewolvesGame.handle(state, "p2", event("night_action", { targets: ["p3"] }), ctx)).toThrow();

    now += 10_000;
    expect(werewolvesGame.onTimer?.(state, ctx)).toBe(true);
    expect(state.stageIndex).toBe(1);
    expect(state.stageActors).toEqual([]);
  });

  it("shows the Robber the stolen card and keeps the private result through day", () => {
    let now = 1_000;
    const ctx = context(
      { lang: "en", roles: ["werewolf", "seer", "robber", "villager", "villager", "villager"] },
      players.slice(0, 3),
      [],
      () => now,
    );
    const state = werewolvesGame.init(ctx);
    if (state.game !== "werewolves") throw new Error("Unexpected game state.");
    state.phase = "night";
    state.stages = ["robber"];
    state.stageIndex = 0;
    state.stageActors = ["p1"];
    state.stageEndsAt = now + 10_000;
    state.roles = { p1: "robber", p2: "villager", p3: "seer" };

    werewolvesGame.handle(state, "p1", event("night_action", { targets: ["p2"] }), ctx);

    expect(werewolvesGame.view(state, "p1", ctx.players, ctx.options)).toMatchObject({
      view: {
        prompt: { kind: "robber", result: [{ target: "p1", role: "villager" }] },
      },
    });
    expect(JSON.stringify(werewolvesGame.view(state, "p2", ctx.players, ctx.options))).not.toContain(
      '"role":"villager"',
    );

    now += 10_000;
    expect(werewolvesGame.onTimer?.(state, ctx)).toBe(true);
    expect(state.phase).toBe("day");
    expect(werewolvesGame.view(state, "p1", ctx.players, ctx.options)).toMatchObject({
      view: {
        privateResults: [{ kind: "robber", cards: [{ target: "p1", role: "villager" }] }],
      },
    });
  });

  it("preserves the original role's power after a Robber swap", () => {
    let now = 1_000;
    const ctx = context(
      { lang: "en", roles: ["werewolf", "seer", "robber", "troublemaker", "villager", "villager"] },
      players.slice(0, 3),
      [],
      () => now,
    );
    const state = werewolvesGame.init(ctx);
    if (state.game !== "werewolves") throw new Error("Unexpected game state.");
    state.phase = "night";
    state.stages = ["robber", "troublemaker"];
    state.stageIndex = 0;
    state.stageActors = ["p1"];
    state.stageEndsAt = now + 10_000;
    state.originalRoles = { p1: "robber", p2: "troublemaker", p3: "villager" };
    state.roles = { ...state.originalRoles };

    werewolvesGame.handle(state, "p1", event("night_action", { targets: ["p2"] }), ctx);
    now += 10_000;
    expect(werewolvesGame.onTimer?.(state, ctx)).toBe(true);

    expect(state.roles).toEqual({ p1: "troublemaker", p2: "robber", p3: "villager" });
    expect(state.stageActors).toEqual(["p2"]);
    expect(werewolvesGame.view(state, "p2", ctx.players, ctx.options)).toMatchObject({
      view: {
        myRole: "troublemaker",
        prompt: { kind: "troublemaker" },
      },
    });
    expect(werewolvesGame.view(state, "p1", ctx.players, ctx.options)).toMatchObject({
      view: { myRole: "robber" },
    });
    expect(JSON.stringify(werewolvesGame.view(state, "p1", ctx.players, ctx.options))).not.toContain(
      '"kind":"troublemaker"',
    );

    werewolvesGame.handle(state, "p2", event("night_action", { targets: ["p1", "p3"] }), ctx);
    expect(state.roles).toEqual({ p1: "villager", p2: "robber", p3: "troublemaker" });
    expect(() => werewolvesGame.handle(state, "p1", event("night_action", { targets: ["p2", "p3"] }), ctx)).toThrow();
  });

  it("retains the Seer's selected center-card results privately", () => {
    const ctx = context(
      { lang: "en", roles: ["werewolf", "seer", "robber", "villager", "villager", "villager"] },
      players.slice(0, 3),
    );
    const state = werewolvesGame.init(ctx);
    if (state.game !== "werewolves") throw new Error("Unexpected game state.");
    state.phase = "night";
    state.stages = ["seer"];
    state.stageIndex = 0;
    state.stageActors = ["p2"];
    state.stageEndsAt = ctx.now() + 10_000;
    state.roles = { p1: "villager", p2: "seer", p3: "werewolf" };
    state.center = ["tanner", "robber", "mason"];

    werewolvesGame.handle(state, "p2", event("night_action", { targets: ["center-0", "center-1"] }), ctx);

    expect(werewolvesGame.view(state, "p2", ctx.players, ctx.options)).toMatchObject({
      view: {
        prompt: {
          kind: "seer",
          result: [
            { target: "center-0", role: "tanner" },
            { target: "center-1", role: "robber" },
          ],
        },
        privateResults: [
          {
            kind: "seer",
            cards: [
              { target: "center-0", role: "tanner" },
              { target: "center-1", role: "robber" },
            ],
          },
        ],
      },
    });
    expect(JSON.stringify(werewolvesGame.view(state, "p1", ctx.players, ctx.options))).not.toContain('"role":"tanner"');
  });

  it("keeps center indexes stable when a card is seen and later taken", () => {
    let now = 1_000;
    const ctx = context(
      { lang: "en", roles: ["seer", "drunk", "werewolf", "mason", "werewolf", "tanner"] },
      players.slice(0, 3),
      [],
      () => now,
    );
    const state = werewolvesGame.init(ctx);
    if (state.game !== "werewolves") throw new Error("Unexpected game state.");
    state.phase = "night";
    state.originalRoles = { p1: "seer", p2: "drunk", p3: "werewolf" };
    state.roles = { ...state.originalRoles };
    state.center = ["mason", "werewolf", "tanner"];
    state.stages = ["seer", "drunk"];
    state.stageIndex = 0;
    state.stageActors = ["p1"];
    state.stageEndsAt = now + 10_000;

    werewolvesGame.handle(state, "p1", event("night_action", { targets: ["center-1", "center-0"] }), ctx);
    now += 10_000;
    expect(werewolvesGame.onTimer?.(state, ctx)).toBe(true);
    expect(state.stageActors).toEqual(["p2"]);
    werewolvesGame.handle(state, "p2", event("night_action", { targets: ["center-1"] }), ctx);
    now += 10_000;
    expect(werewolvesGame.onTimer?.(state, ctx)).toBe(true);

    expect(state.roles.p2).toBe("werewolf");
    expect(state.center[1]).toBe("drunk");
    expect(werewolvesGame.view(state, "p1", ctx.players, ctx.options)).toMatchObject({
      view: {
        privateResults: [
          {
            kind: "seer",
            cards: [
              { target: "center-1", role: "werewolf" },
              { target: "center-0", role: "mason" },
            ],
          },
        ],
        availableRoles: [
          { role: "werewolf", count: 2 },
          { role: "mason", count: 1 },
          { role: "seer", count: 1 },
          { role: "drunk", count: 1 },
          { role: "tanner", count: 1 },
        ],
      },
    });
  });

  it("shows the Seer's selected player's card", () => {
    const ctx = context(
      { lang: "en", roles: ["werewolf", "seer", "robber", "villager", "villager", "villager"] },
      players.slice(0, 3),
    );
    const state = werewolvesGame.init(ctx);
    if (state.game !== "werewolves") throw new Error("Unexpected game state.");
    state.phase = "night";
    state.stages = ["seer"];
    state.stageIndex = 0;
    state.stageActors = ["p2"];
    state.stageEndsAt = ctx.now() + 10_000;
    state.roles = { p1: "villager", p2: "seer", p3: "werewolf" };

    werewolvesGame.handle(state, "p2", event("night_action", { targets: ["p3"] }), ctx);

    expect(werewolvesGame.view(state, "p2", ctx.players, ctx.options)).toMatchObject({
      view: {
        prompt: { kind: "seer", result: [{ target: "p3", role: "werewolf" }] },
        privateResults: [{ kind: "seer", cards: [{ target: "p3", role: "werewolf" }] }],
      },
    });
  });

  it("lets the original Insomniac see their final card, but not the Robber who stole it", () => {
    let now = 1_000;
    const ctx = context(
      { lang: "en", roles: ["werewolf", "seer", "robber", "insomniac", "villager", "villager"] },
      players.slice(0, 3),
      [],
      () => now,
    );
    const state = werewolvesGame.init(ctx);
    if (state.game !== "werewolves") throw new Error("Unexpected game state.");
    state.stages = ["robber", "insomniac"];
    state.stageIndex = 0;
    state.roles = { p1: "robber", p2: "insomniac", p3: "villager" };
    state.originalRoles = { ...state.roles };
    state.acked = ["p1", "p2"];
    werewolvesGame.handle(state, "p3", event("ack_role"), ctx);

    werewolvesGame.handle(state, "p1", event("night_action", { targets: ["p2"] }), ctx);
    now += 10_000;
    expect(werewolvesGame.onTimer?.(state, ctx)).toBe(true);

    expect(state.roles).toEqual({ p1: "insomniac", p2: "robber", p3: "villager" });
    expect(state.stageActors).toEqual(["p2"]);
    expect(werewolvesGame.view(state, "p2", ctx.players, ctx.options)).toMatchObject({
      view: {
        prompt: { kind: "insomniac", result: [{ target: "p2", role: "robber" }] },
        privateResults: [{ kind: "insomniac", cards: [{ target: "p2", role: "robber" }] }],
      },
    });
    expect(werewolvesGame.view(state, "p1", ctx.players, ctx.options)).toMatchObject({
      view: {
        privateResults: [{ kind: "robber", cards: [{ target: "p1", role: "insomniac" }] }],
      },
    });

    now += 10_000;
    expect(werewolvesGame.onTimer?.(state, ctx)).toBe(true);
    expect(state.phase).toBe("day");
    expect(werewolvesGame.view(state, "p2", ctx.players, ctx.options)).toMatchObject({
      view: { privateResults: [{ kind: "insomniac", cards: [{ target: "p2", role: "robber" }] }] },
    });
    expect(werewolvesGame.view(state, "p1", ctx.players, ctx.options)).toMatchObject({
      view: { privateResults: [{ kind: "robber" }] },
    });
  });

  it("lets the original Insomniac check their card even when it did not change", () => {
    const ctx = context(
      { lang: "en", roles: ["werewolf", "seer", "robber", "insomniac", "villager", "villager"] },
      players.slice(0, 3),
    );
    const state = werewolvesGame.init(ctx);
    if (state.game !== "werewolves") throw new Error("Unexpected game state.");
    state.stages = ["insomniac"];
    state.stageIndex = 0;
    state.roles = { p1: "werewolf", p2: "insomniac", p3: "villager" };
    state.originalRoles = { ...state.roles };
    state.acked = ["p1", "p2"];

    werewolvesGame.handle(state, "p3", event("ack_role"), ctx);

    expect(state.stageActors).toEqual(["p2"]);
    expect(werewolvesGame.view(state, "p2", ctx.players, ctx.options)).toMatchObject({
      view: {
        prompt: { kind: "insomniac", result: [{ target: "p2", role: "insomniac" }] },
        privateResults: [{ kind: "insomniac", cards: [{ target: "p2", role: "insomniac" }] }],
      },
    });
  });

  it("starts the timed vote when the host ends the day early", () => {
    const ctx = context(
      { lang: "en", roles: ["werewolf", "seer", "robber", "minion", "villager", "villager"] },
      players.slice(0, 3),
      [],
      () => 1_000,
    );
    const state = werewolvesGame.init(ctx);
    if (state.game !== "werewolves") throw new Error("Unexpected game state.");

    for (const player of ctx.players) werewolvesGame.handle(state, player.id, event("ack_role"), ctx);
    state.phase = "day";
    state.dayEndsAt = 999_999;

    werewolvesGame.handle(state, "p1", event("end_game"), ctx);

    expect(state.phase).toBe("vote");
    expect(state.dayEndsAt).toBeUndefined();
    expect(state.voteEndsAt).toBe(11_000);
    expect(JSON.stringify(werewolvesGame.view(state, "p1", ctx.players, ctx.options))).not.toContain('"roles"');
    werewolvesGame.handle(state, "p1", event("vote", { target: "p2" }), ctx);
    werewolvesGame.handle(state, "p2", event("vote", { target: "p1" }), ctx);
    werewolvesGame.handle(state, "p3", event("vote", { target: "p1" }), ctx);
    expect(state.phase).toBe("result");
    const resultView = werewolvesGame.view(state, "p1", ctx.players, ctx.options);
    expect(JSON.stringify(resultView)).toContain('"roles"');
    expect(() => werewolvesGame.handle(state, "p1", event("end_game"), ctx)).toThrow();
  });

  it("starts a 10-second vote when the day timer expires", () => {
    let now = 5_000;
    const ctx = context(
      { lang: "en", roles: ["werewolf", "seer", "robber", "minion", "villager", "villager"] },
      players.slice(0, 3),
      [],
      () => now,
    );
    const state = werewolvesGame.init(ctx);
    if (state.game !== "werewolves") throw new Error("Unexpected game state.");
    state.phase = "day";
    state.dayEndsAt = now;

    expect(werewolvesGame.onTimer?.(state, ctx)).toBe(true);
    expect(state.phase).toBe("vote");
    expect(state.voteEndsAt).toBe(now + 10_000);
    now += 10_000;
    expect(werewolvesGame.onTimer?.(state, ctx)).toBe(true);
    expect(state.phase).toBe("result");
    expect(state.dead).toEqual([]);
    expect(state.winners).toEqual(["werewolf"]);
  });

  it("resolves tied kills as no deaths and a Werewolves win", () => {
    const ctx = context(
      { lang: "en", roles: ["werewolf", "seer", "robber", "minion", "villager", "villager"] },
      players.slice(0, 3),
    );
    const state = werewolvesGame.init(ctx);
    if (state.game !== "werewolves") throw new Error("Unexpected game state.");
    state.phase = "vote";
    state.voteEndsAt = 2_000;
    state.roles = { p1: "werewolf", p2: "villager", p3: "seer" };
    state.votes = { p1: "p2", p2: "p3", p3: "p1" };

    expect(werewolvesGame.onTimer?.(state, { ...ctx, now: () => 2_000 })).toBe(true);
    expect(state.phase).toBe("result");
    expect(state.dead).toEqual([]);
    expect(state.winners).toEqual(["werewolf"]);
  });

  it("applies Hunter chain kills and awards the Tanner when killed", () => {
    const ctx = context(
      { lang: "en", roles: ["werewolf", "seer", "robber", "minion", "villager", "villager"] },
      players.slice(0, 3),
    );
    const state = werewolvesGame.init(ctx);
    if (state.game !== "werewolves") throw new Error("Unexpected game state.");
    state.phase = "vote";
    state.voteEndsAt = 2_000;
    state.roles = { p1: "hunter", p2: "tanner", p3: "werewolf" };
    state.votes = { p1: "p2", p2: "p1", p3: "p1" };

    werewolvesGame.onTimer?.(state, { ...ctx, now: () => 2_000 });

    expect(state.dead).toEqual(expect.arrayContaining(["p1", "p2"]));
    expect(state.winners).toEqual(["tanner"]);
  });

  it("lets a Hunter's chain kill eliminate a Werewolf", () => {
    const ctx = context(
      { lang: "en", roles: ["werewolf", "seer", "robber", "minion", "villager", "villager"] },
      players.slice(0, 3),
    );
    const state = werewolvesGame.init(ctx);
    if (state.game !== "werewolves") throw new Error("Unexpected game state.");
    state.phase = "vote";
    state.voteEndsAt = 2_000;
    state.roles = { p1: "hunter", p2: "villager", p3: "werewolf" };
    state.votes = { p1: "p3", p2: "p1", p3: "p1" };

    werewolvesGame.onTimer?.(state, { ...ctx, now: () => 2_000 });

    expect(state.dead).toEqual(expect.arrayContaining(["p1", "p3"]));
    expect(state.winners).toEqual(["village"]);
  });

  it("does not include a role card in a player's day view", () => {
    const ctx = context(
      { lang: "en", roles: ["werewolf", "seer", "robber", "minion", "villager", "villager"] },
      players.slice(0, 3),
    );
    const state = werewolvesGame.init(ctx);
    if (state.game !== "werewolves") throw new Error("Unexpected game state.");
    state.phase = "day";
    state.dayEndsAt = Date.now() + 60_000;

    const dayView = werewolvesGame.view(state, "p1", ctx.players, ctx.options);
    expect(JSON.stringify(dayView)).not.toContain("myRole");
  });
});
