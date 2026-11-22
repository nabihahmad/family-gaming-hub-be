import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import type WebSocket from "ws";
import type { AccessPrincipal } from "../auth/types.js";
import { CardCache } from "../cards/cache.js";
import { selectCards } from "../cards/selection.js";
import { GameRuleError } from "../games/common.js";
import { gameRegistry } from "../games/registry.js";
import { validateWerewolvesOptions } from "../games/werewolves/index.js";
import type { GameContext, GameEvent } from "../games/types.js";
import type { GameId, GameOptions, Lang } from "../protocol/types.js";
import { HttpError } from "../util/errors.js";
import { Room, type RoomPlayer } from "./Room.js";

const roomAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const maxPlayers = 12;
const reconnectTokenBytes = 32;
const hostGraceMs = 30_000;
const lobbyPlayerTtlMs = 30 * 60_000;
const disconnectedRoomTtlMs = 2 * 60 * 60_000;

export interface JoinedPlayer {
  room: Room;
  player: RoomPlayer;
  token: string;
}

export class RoomManager {
  private readonly rooms = new Map<string, Room>();

  constructor(
    private readonly cards: CardCache,
    private readonly now: () => number = Date.now,
    private readonly rng: () => number = Math.random,
  ) {}

  createRoom(ownerId: string): Room {
    let code = "";
    do {
      code = Array.from({ length: 4 }, () => roomAlphabet[randomInt(roomAlphabet.length)]).join("");
    } while (this.rooms.has(code));
    const room = new Room(code, ownerId, this.now());
    this.rooms.set(code, room);
    return room;
  }

  getRoom(code: string): Room | undefined {
    return this.rooms.get(code.toUpperCase());
  }

  getPublicStatus(code: string): { exists: false } | { exists: true; game?: GameId; phase: "lobby" | "playing" } {
    const room = this.getRoom(code);
    if (!room) return { exists: false };
    return {
      exists: true,
      ...(room.game ? { game: room.game } : {}),
      phase: room.phase,
    };
  }

  async join(
    roomCode: string,
    name: string,
    playerId: string | undefined,
    token: string | undefined,
    socket: WebSocket,
    principal: AccessPrincipal,
  ): Promise<JoinedPlayer> {
    const room = this.getRoom(roomCode);
    if (!room) throw new HttpError(404, "ROOM_NOT_FOUND", "Room not found.");
    if (principal.role === "admin" && principal.userId !== room.ownerId) {
      throw new HttpError(403, "NOT_ROOM_OWNER", "This room belongs to another admin.");
    }
    return room.enqueue(() => {
      const hasPlayerId = Boolean(playerId);
      const hasToken = Boolean(token);
      if (hasPlayerId || hasToken) {
        if (!playerId || !token) throw new HttpError(401, "INVALID_TOKEN", "Room credentials are invalid.");
        const player = room.players.find((item) => item.id === playerId);
        if (!player) throw new HttpError(401, "INVALID_TOKEN", "Room credentials are invalid.");
        const actual = createHash("sha256").update(token).digest();
        const expected = Buffer.from(player.tokenHash, "hex");
        if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
          throw new HttpError(401, "INVALID_TOKEN", "Room credentials are invalid.");
        }
        const previousSocket = player.socket;
        player.socket = socket;
        player.connected = true;
        player.accessRole = principal.role;
        player.userId = principal.userId;
        player.lastSeenAt = this.now();
        const currentHost = room.players.find((item) => item.id === room.hostId);
        if (currentHost && !this.isRoomAdmin(room, currentHost)) room.hostId = "";
        if (
          this.isRoomAdmin(room, player) &&
          (!room.hostId || !room.players.some((item) => item.id === room.hostId && item.connected))
        ) {
          room.hostId = player.id;
        }
        if (room.hostId === player.id) delete room.hostDisconnectedAt;
        if (previousSocket && previousSocket !== socket) previousSocket.close(4001, "Reconnected from another device");
        room.lastActivityAt = this.now();
        return { room, player, token };
      }

      if (room.phase !== "lobby") throw new HttpError(409, "INVALID_PHASE", "This room is already playing.");
      const connectedCount = room.players.filter((player) => player.connected).length;
      if (connectedCount >= maxPlayers) throw new HttpError(409, "ROOM_FULL", "This room is full.");
      const cleanName = sanitizeName(name);
      const uniqueName = this.uniqueName(room.players, cleanName);
      const newToken = randomBytes(reconnectTokenBytes).toString("base64url");
      const player: RoomPlayer = {
        id: randomUUID(),
        name: uniqueName,
        connected: true,
        accessRole: principal.role,
        userId: principal.userId,
        tokenHash: createHash("sha256").update(newToken).digest("hex"),
        socket,
        joinedAt: this.now(),
        lastSeenAt: this.now(),
      };
      room.players.push(player);
      if (this.isRoomAdmin(room, player) && !room.hostId) room.hostId = player.id;
      room.lastActivityAt = this.now();
      return { room, player, token: newToken };
    });
  }

  async handle(
    room: Room,
    player: RoomPlayer,
    socket: WebSocket,
    message: { type: string; payload: Record<string, unknown> },
    isAuthorized: () => boolean,
  ): Promise<void> {
    await room
      .enqueue(() => {
        if (!isAuthorized()) {
          socket.close(4003, "Access revoked");
          return;
        }
        if (player.socket !== socket) return;
        if (message.type === "ping") {
          player.lastSeenAt = this.now();
          send(socket, { type: "pong", payload: {} });
          return;
        }
        if (message.type === "select_game") {
          this.assertHost(room, player);
          this.assertLobby(room);
          const game = message.payload.game as GameId;
          const options = this.validateOptions(room, game, message.payload.options);
          room.game = game;
          room.options = options;
          room.lastActivityAt = this.now();
          this.broadcast(room);
          return;
        }
        if (message.type === "start_game") {
          this.assertHost(room, player);
          this.assertLobby(room);
          if (!room.game || !room.options) throw new HttpError(409, "INVALID_PHASE", "Choose a game before starting.");
          const module = gameRegistry[room.game]!;
          const activePlayers = room.players.filter((item) => item.connected);
          if (activePlayers.length < module.minPlayers || activePlayers.length > module.maxPlayers) {
            throw new HttpError(
              400,
              "NOT_ENOUGH_PLAYERS",
              `This game needs ${module.minPlayers} to ${module.maxPlayers} players.`,
            );
          }
          const context = this.gameContext(room, room.game, room.options, true);
          room.gameState = module.init(context);
          room.phase = "playing";
          room.lastActivityAt = this.now();
          this.broadcast(room);
          return;
        }
        if (message.type === "back_to_lobby") {
          this.assertHost(room, player);
          room.phase = "lobby";
          delete room.gameState;
          room.lastActivityAt = this.now();
          this.broadcast(room);
          return;
        }
        if (message.type === "game_event") {
          if (room.phase !== "playing" || !room.game || !room.gameState || !room.options) {
            throw new HttpError(409, "INVALID_PHASE", "There is no active game.");
          }
          const data = (message.payload.data ?? {}) as Record<string, unknown>;
          const event: GameEvent = { name: String(message.payload.name), data };
          if (["begin", "reveal_imposter", "next_round", "next_game", "end_day"].includes(event.name)) {
            this.assertHost(room, player);
          }
          const module = gameRegistry[room.game]!;
          const context = this.gameContext(room, room.game, room.options, false);
          room.gameState = module.handle(room.gameState, player.id, event, context);
          room.lastActivityAt = this.now();
          this.broadcast(room);
        }
      })
      .catch((error: unknown) => {
        if (error instanceof GameRuleError) {
          throw new HttpError(400, error.code, error.message);
        }
        throw error;
      });
  }

  async disconnected(room: Room, player: RoomPlayer, socket: WebSocket): Promise<void> {
    await room.enqueue(() => {
      if (player.socket !== socket) return;
      player.connected = false;
      player.socket = null;
      player.lastSeenAt = this.now();
      room.lastActivityAt = this.now();
      if (room.hostId === player.id) room.hostDisconnectedAt = this.now();
      this.broadcast(room);
    });
  }

  async publish(room: Room): Promise<void> {
    await room.enqueue(() => this.broadcast(room));
  }

  async tick(): Promise<void> {
    const now = this.now();
    for (const [code, room] of this.rooms) {
      try {
        await room.enqueue(() => {
          let changed = false;
          if (room.hostDisconnectedAt !== undefined && now - room.hostDisconnectedAt >= hostGraceMs) {
            const nextHost = room.players
              .filter((player) => player.connected && this.isRoomAdmin(room, player))
              .sort((a, b) => a.joinedAt - b.joinedAt)[0];
            if (nextHost) {
              room.hostId = nextHost.id;
              delete room.hostDisconnectedAt;
              changed = true;
            }
          }
          if (room.phase === "lobby") {
            const expired = room.players.filter(
              (player) => !player.connected && now - player.lastSeenAt >= lobbyPlayerTtlMs,
            );
            if (expired.length) {
              room.players.splice(
                0,
                room.players.length,
                ...room.players.filter((player) => !expired.includes(player)),
              );
              if (!room.players.some((player) => player.id === room.hostId)) {
                room.hostId = room.players.find((player) => player.connected)?.id ?? "";
                delete room.hostDisconnectedAt;
              }
              changed = true;
            }
          }
          if (room.phase === "playing" && room.game && room.gameState && room.options) {
            const module = gameRegistry[room.game]!;
            if (module.onTimer?.(room.gameState, this.gameContext(room, room.game, room.options, false)))
              changed = true;
          }
          if (changed) this.broadcast(room);
          if (!room.players.some((player) => player.connected) && now - room.lastActivityAt >= disconnectedRoomTtlMs) {
            this.rooms.delete(code);
          }
        });
      } catch {
        console.error("Room timer processing failed.");
      }
    }
  }

  allRooms(): Room[] {
    return [...this.rooms.values()];
  }

  private validateOptions(room: Room, game: GameId, input: unknown): GameOptions {
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw new HttpError(400, "INVALID_ACTION", "Game options are required.");
    const raw = input as Record<string, unknown>;
    if (raw.lang !== "en" && raw.lang !== "ar") throw new HttpError(400, "INVALID_ACTION", "Choose English or Arabic.");
    const lang: Lang = raw.lang;
    const options: GameOptions = { lang };
    if (game === "werewolves") {
      const activePlayers = room.players.filter((player) => player.connected).length;
      try {
        validateWerewolvesOptions(raw.roles, activePlayers);
      } catch (error) {
        if (error instanceof GameRuleError) throw new HttpError(400, error.code, error.message);
        throw error;
      }
      options.roles = raw.roles as string[];
      return options;
    }

    if (
      !Array.isArray(raw.packs) ||
      raw.packs.length < 1 ||
      raw.packs.length > 10 ||
      raw.packs.some((id) => typeof id !== "string") ||
      new Set(raw.packs).size !== raw.packs.length
    ) {
      throw new HttpError(400, "INVALID_ACTION", "Choose at least one valid word pack.");
    }
    const packs = raw.packs as string[];
    const cards = this.cards.select(game, lang, packs);
    if (game === "codenames") {
      try {
        selectCards(cards, game, lang, 25, this.rng);
      } catch {
        throw new HttpError(400, "NOT_ENOUGH_CARDS", "The selected packs need 25 distinct cards.");
      }
    } else if (!cards.length) {
      throw new HttpError(400, "NOT_ENOUGH_CARDS", "The selected packs do not contain any cards.");
    }
    options.packs = packs;
    if (game === "imposter") {
      const imposters = raw.imposters ?? 1;
      const connectedCount = room.players.filter((player) => player.connected).length;
      const maxImposters = Math.max(1, Math.floor((connectedCount - 1) / 2));
      if (!Number.isInteger(imposters) || Number(imposters) < 1 || Number(imposters) > Math.min(3, maxImposters)) {
        throw new HttpError(400, "INVALID_ACTION", "Choose a valid number of imposters for this room.");
      }
      options.imposters = Number(imposters);
    }
    return options;
  }

  private gameContext(room: Room, game: GameId, options: GameOptions, selectAtStart: boolean): GameContext {
    let cards: GameContext["cards"] = [];
    if (selectAtStart && game !== "werewolves") {
      const available = this.cards.select(game, options.lang, options.packs ?? []);
      if (game === "codenames") cards = selectCards(available, game, options.lang, 25, this.rng);
      else cards = available.flatMap((card) => (card[options.lang] ? [card[options.lang]!] : []));
    }
    return {
      players: room.players.map(({ id, name, connected }) => ({ id, name, connected })),
      options,
      cards,
      rng: this.rng,
      now: this.now,
    };
  }

  private assertHost(room: Room, player: RoomPlayer): void {
    if (room.hostId !== player.id || !this.isRoomAdmin(room, player)) {
      throw new HttpError(403, "NOT_HOST", "Only the room's admin can do that.");
    }
  }

  private isRoomAdmin(room: Room, player: RoomPlayer): boolean {
    return player.accessRole === "admin" && player.userId === room.ownerId;
  }

  private assertLobby(room: Room): void {
    if (room.phase !== "lobby") throw new HttpError(409, "INVALID_PHASE", "The room is not in the lobby.");
  }

  private uniqueName(players: RoomPlayer[], name: string): string {
    const names = new Set(players.map((player) => player.name.toLocaleLowerCase()));
    if (!names.has(name.toLocaleLowerCase())) return name;
    let suffix = 2;
    while (true) {
      const ending = ` ${suffix}`;
      const candidate = `${name.slice(0, 20 - ending.length)}${ending}`;
      if (!names.has(candidate.toLocaleLowerCase())) return candidate;
      suffix++;
    }
  }

  private broadcast(room: Room): void {
    for (const player of room.players) {
      if (!player.connected || !player.socket) continue;
      send(player.socket, { type: "room_state", payload: room.toJSON() });
      if (room.phase === "playing" && room.game && room.gameState && room.options) {
        const view = gameRegistry[room.game]!.view(room.gameState, player.id, room.toJSON().players, room.options);
        if (view === null) continue;
        send(player.socket, {
          type: "game_view",
          payload: view,
        });
      }
    }
  }
}

export function sanitizeName(input: string): string {
  const cleaned = [...input]
    .filter((character) => {
      const code = character.charCodeAt(0);
      return code >= 32 && code !== 127;
    })
    .join("")
    .trim();
  if (!cleaned || cleaned.length > 20)
    throw new HttpError(400, "INVALID_ACTION", "Enter a name between 1 and 20 characters.");
  return cleaned;
}

export function send(socket: WebSocket, message: { type: string; payload: unknown }): void {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
}
