import type WebSocket from "ws";
import type { AccessPrincipal } from "../auth/types.js";
import type { GameState } from "../games/types.js";
import type { GameId, GameOptions, Player, RoomState } from "../protocol/types.js";

export interface RoomPlayer extends Player {
  accessRole: AccessPrincipal["role"];
  userId: string;
  tokenHash: string;
  socket: WebSocket | null;
  joinedAt: number;
  lastSeenAt: number;
}

export class Room {
  hostId = "";
  phase: "lobby" | "playing" = "lobby";
  game?: GameId;
  options?: GameOptions;
  gameState?: GameState;
  lastActivityAt: number;
  hostDisconnectedAt?: number;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    readonly code: string,
    readonly ownerId: string,
    readonly createdAt: number,
  ) {
    this.lastActivityAt = createdAt;
  }

  readonly players: RoomPlayer[] = [];

  enqueue<T>(work: () => Promise<T> | T): Promise<T> {
    const operation = this.queue.then(work);
    this.queue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  toJSON(): RoomState {
    return {
      code: this.code,
      hostId: this.hostId,
      phase: this.phase,
      ...(this.game ? { game: this.game } : {}),
      ...(this.options ? { options: this.options } : {}),
      players: this.players.map(({ id, name, connected }) => ({ id, name, connected })),
    };
  }
}
