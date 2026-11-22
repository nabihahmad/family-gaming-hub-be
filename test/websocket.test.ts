import { createServer } from "node:http";
import express from "express";
import WebSocket from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { AuthService } from "../src/auth/AuthService.js";
import { hashPassword } from "../src/auth/password.js";
import { CardCache } from "../src/cards/cache.js";
import { createAuthRouter } from "../src/http/auth.js";
import { createHttpApp } from "../src/http/routes.js";
import { RoomManager } from "../src/rooms/RoomManager.js";
import { attachWebSocketServer } from "../src/ws/server.js";
import type { CardDocument, PackDocument } from "../src/protocol/types.js";

const origin = "http://localhost:5173";

interface Envelope {
  type: string;
  payload: Record<string, unknown>;
}

function isEnvelope(value: unknown): value is Envelope {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    typeof value.type === "string" &&
    "payload" in value &&
    typeof value.payload === "object" &&
    value.payload !== null
  );
}

class TestClient {
  readonly socket: WebSocket;
  private messages: Envelope[] = [];
  private waiters: Array<{
    predicate: (message: Envelope) => boolean;
    resolve: (message: Envelope) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];

  constructor(url: string) {
    this.socket = new WebSocket(url, { headers: { Origin: origin } });
    this.socket.on("message", (data) => {
      const value: unknown = JSON.parse(data.toString());
      if (!isEnvelope(value)) return;
      const waiterIndex = this.waiters.findIndex((waiter) => waiter.predicate(value));
      if (waiterIndex >= 0) {
        const [waiter] = this.waiters.splice(waiterIndex, 1);
        if (waiter) {
          clearTimeout(waiter.timer);
          waiter.resolve(value);
        }
      } else {
        this.messages.push(value);
      }
    });
    this.socket.on("error", () => {});
  }

  async open(): Promise<void> {
    if (this.socket.readyState === WebSocket.OPEN) return;
    await new Promise<void>((resolve, reject) => {
      this.socket.once("open", resolve);
      this.socket.once("error", reject);
    });
  }

  send(type: string, payload: Record<string, unknown>): void {
    this.socket.send(JSON.stringify({ type, payload }));
  }

  waitFor(predicate: (message: Envelope) => boolean): Promise<Envelope> {
    const index = this.messages.findIndex(predicate);
    if (index >= 0) return Promise.resolve(this.messages.splice(index, 1)[0]!);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((waiter) => waiter.resolve !== resolve);
        reject(new Error("Timed out waiting for WebSocket message."));
      }, 5000);
      this.waiters.push({ predicate, resolve, timer });
    });
  }

  close(): Promise<void> {
    if (this.socket.readyState === WebSocket.CLOSED) return Promise.resolve();
    return new Promise((resolve) => {
      this.socket.once("close", () => resolve());
      this.socket.close();
    });
  }

  waitForClose(): Promise<number> {
    if (this.socket.readyState === WebSocket.CLOSED) return Promise.resolve(1000);
    return new Promise((resolve) => this.socket.once("close", (code) => resolve(code)));
  }
}

function asPayload(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Unexpected WebSocket payload.");
  return value as Record<string, unknown>;
}

describe("HTTP and WebSocket protocol", () => {
  const clients: TestClient[] = [];
  let attached: ReturnType<typeof attachWebSocketServer> | undefined;
  let server: ReturnType<typeof createServer> | undefined;

  afterEach(async () => {
    await Promise.all(clients.splice(0).map((client) => client.close()));
    await attached?.close();
    attached = undefined;
    if (server?.listening) await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  });

  it("creates rooms, plays Imposter, and reconnects a player with the issued token", async () => {
    const cards: CardDocument[] = Array.from({ length: 30 }, (_, index) => ({
      pack: "everyday",
      games: ["codenames", "imposter"],
      active: true,
      en: { word: `word-${index}`, hint: "family" },
      ar: { word: `كلمة ${index}`, hint: "عائلة" },
    }));
    const packs: PackDocument[] = [
      {
        _id: "everyday",
        name: { en: "Everyday", ar: "الحياة اليومية" },
        games: ["codenames", "imposter"],
        active: true,
      },
    ];
    const cache = new CardCache({
      loadActiveCards: async () => cards,
      loadActivePacks: async () => packs,
    });
    await cache.refresh();
    const adminPasswordHash = await hashPassword("test-admin-password-123");
    const adminUser = {
      _id: "admin",
      username: "admin",
      passwordSalt: adminPasswordHash.salt,
      passwordHash: adminPasswordHash.hash,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const auth = new AuthService(async (username) => (username === adminUser.username ? adminUser : null));
    const manager = new RoomManager(cache);
    server = createServer(createHttpApp(manager, cache, [origin], express.Router(), auth, createAuthRouter(auth)));
    attached = attachWebSocketServer(server, manager, auth, [origin]);
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Server failed to bind.");
    const httpUrl = `http://127.0.0.1:${address.port}`;

    expect(await (await fetch(`${httpUrl}/health`)).json()).toEqual({ ok: true });
    const unauthenticatedCreate = await fetch(`${httpUrl}/api/rooms`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(unauthenticatedCreate.status).toBe(401);

    const loginResponse = await fetch(`${httpUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "test-admin-password-123" }),
    });
    expect(loginResponse.status).toBe(200);
    const adminSession = asPayload(await loginResponse.json());
    const adminToken = String(adminSession.accessToken);
    const guestResponses = await Promise.all(
      Array.from({ length: 2 }, () =>
        fetch(`${httpUrl}/api/auth/guest`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code: adminSession.accessCode }),
        }),
      ),
    );
    const guestTokens = await Promise.all(
      guestResponses.map(async (response) => {
        expect(response.status).toBe(200);
        return String(asPayload(await response.json()).accessToken);
      }),
    );
    const guestCreate = await fetch(`${httpUrl}/api/rooms`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${guestTokens[0]}` },
      body: "{}",
    });
    expect(guestCreate.status).toBe(403);

    const createResponse = await fetch(`${httpUrl}/api/rooms`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
      body: "{}",
    });
    const roomResponse: unknown = await createResponse.json();
    const room = asPayload(roomResponse);
    expect(createResponse.status).toBe(201);
    expect(typeof room.code).toBe("string");
    const code = String(room.code);
    expect(
      await (
        await fetch(`${httpUrl}/api/rooms/${code}`, {
          headers: { Authorization: `Bearer ${guestTokens[0]}` },
        })
      ).json(),
    ).toMatchObject({ exists: true, phase: "lobby" });
    expect(
      await (
        await fetch(`${httpUrl}/api/packs?game=imposter&lang=en`, {
          headers: { Authorization: `Bearer ${guestTokens[0]}` },
        })
      ).json(),
    ).toMatchObject([{ id: "everyday", count: 30 }]);

    const wsUrl = `ws://127.0.0.1:${address.port}/ws`;
    const host = new TestClient(wsUrl);
    const second = new TestClient(wsUrl);
    const third = new TestClient(wsUrl);
    clients.push(host, second, third);
    await Promise.all([host.open(), second.open(), third.open()]);
    host.send("join", { roomCode: code, name: "Host", accessToken: adminToken });
    second.send("join", { roomCode: code, name: "Player", accessToken: guestTokens[0] });
    third.send("join", { roomCode: code, name: "Player", accessToken: guestTokens[1] });
    const joined = await Promise.all(
      [host, second, third].map((client) => client.waitFor((message) => message.type === "joined")),
    );
    const credentials = joined.map((message) => asPayload(message.payload));
    expect(credentials.map((item) => item.playerId)).toHaveLength(3);

    second.send("select_game", {
      game: "imposter",
      options: { lang: "en", packs: ["everyday"], imposters: 1 },
    });
    const guestHostAttempt = await second.waitFor((message) => message.type === "error");
    expect(asPayload(guestHostAttempt.payload).code).toBe("NOT_HOST");

    host.send("select_game", { game: "imposter", options: { lang: "en", packs: ["everyday"], imposters: 1 } });
    host.send("start_game", {});
    const revealMessages = await Promise.all(
      [host, second, third].map((client) =>
        client.waitFor((message) => message.type === "game_view" && asPayload(message.payload).view !== undefined),
      ),
    );
    const views = revealMessages.map((message) => asPayload(asPayload(message.payload).view));
    expect(views.every((view) => view.phase === "reveal")).toBe(true);
    for (const [index, view] of views.entries()) {
      if (view.isImposter === true) expect(view).not.toHaveProperty("word");
      else expect(view).toHaveProperty("word");
      [host, second, third][index]!.send("game_event", { name: "ready" });
    }

    const discussion = await Promise.all(
      [host, second, third].map((client) =>
        client.waitFor(
          (message) =>
            message.type === "game_view" && asPayload(asPayload(message.payload).view).phase === "discussion",
        ),
      ),
    );
    expect(discussion).toHaveLength(3);
    host.send("game_event", { name: "reveal_imposter" });
    const result = await host.waitFor(
      (message) => message.type === "game_view" && asPayload(asPayload(message.payload).view).phase === "result",
    );
    expect(asPayload(asPayload(result.payload).view)).toHaveProperty("result");

    const hostId = String(credentials[0]!.playerId);
    const hostToken = String(credentials[0]!.token);
    await host.close();
    const reconnected = new TestClient(wsUrl);
    clients.push(reconnected);
    await reconnected.open();
    reconnected.send("join", {
      roomCode: code,
      name: "Host",
      accessToken: adminToken,
      playerId: hostId,
      token: hostToken,
    });
    const rejoined = asPayload((await reconnected.waitFor((message) => message.type === "joined")).payload);
    expect(rejoined.playerId).toBe(hostId);
    expect(rejoined.token).toBe(hostToken);
    const resumedView = await reconnected.waitFor(
      (message) => message.type === "game_view" && asPayload(asPayload(message.payload).view).phase === "result",
    );
    expect(asPayload(asPayload(resumedView.payload).view)).toHaveProperty("result");

    const revoked = [second, third, reconnected].map((client) => client.waitForClose());
    const logoutResponse = await fetch(`${httpUrl}/api/auth/logout`, {
      method: "POST",
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(logoutResponse.status).toBe(200);
    expect(await Promise.all(revoked)).toEqual([4003, 4003, 4003]);
    const revokedGuestRequest = await fetch(`${httpUrl}/api/packs?game=imposter&lang=en`, {
      headers: { Authorization: `Bearer ${guestTokens[0]}` },
    });
    expect(revokedGuestRequest.status).toBe(401);
  });
});
