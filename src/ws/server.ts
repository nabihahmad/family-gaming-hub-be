import type { Server } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import type { AuthService } from "../auth/AuthService.js";
import type { AccessSession } from "../auth/types.js";
import { clientMessageSchema } from "../protocol/schemas.js";
import type { RoomManager } from "../rooms/RoomManager.js";
import { send } from "../rooms/RoomManager.js";
import type { RoomPlayer } from "../rooms/Room.js";
import type { Room } from "../rooms/Room.js";
import { HttpError } from "../util/errors.js";

interface ConnectionContext {
  room: Room;
  player: RoomPlayer;
  session: AccessSession;
}
interface SocketWithHealth extends WebSocket {
  isAlive?: boolean;
}

export function attachWebSocketServer(server: Server, rooms: RoomManager, auth: AuthService, allowedOrigins: string[]) {
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 4096, perMessageDeflate: false });
  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const origin = request.headers.origin;
    if (url.pathname !== "/ws" || typeof origin !== "string" || !allowedOrigins.includes(origin)) {
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    sockets.handleUpgrade(request, socket, head, (webSocket) => {
      sockets.emit("connection", webSocket, request);
    });
  });

  sockets.on("connection", (rawSocket) => {
    const socket = rawSocket as SocketWithHealth;
    socket.isAlive = true;
    let context: ConnectionContext | null = null;
    let joining = false;
    let session: AccessSession | null = null;
    const authTimeout = setTimeout(() => {
      if (!session && socket.readyState === WebSocket.OPEN) socket.close(1008, "Access session required");
    }, 10_000);
    authTimeout.unref();
    let rateWindow = Date.now();
    let messageCount = 0;
    socket.on("pong", () => {
      socket.isAlive = true;
    });
    socket.on("message", (raw, isBinary) => {
      if (isBinary) {
        sendError(socket, "INVALID_MESSAGE", "Only JSON text messages are supported.");
        return;
      }
      const currentTime = Date.now();
      if (currentTime - rateWindow >= 1000) {
        rateWindow = currentTime;
        messageCount = 0;
      }
      messageCount++;
      if (messageCount > 20) {
        sendError(socket, "INVALID_MESSAGE", "Too many messages.");
        socket.close(1008, "Rate limit exceeded");
        return;
      }

      let decoded: unknown;
      try {
        const text = Array.isArray(raw)
          ? Buffer.concat(raw).toString()
          : Buffer.isBuffer(raw)
            ? raw.toString()
            : Buffer.from(raw).toString();
        decoded = JSON.parse(text);
      } catch {
        sendError(socket, "INVALID_MESSAGE", "Message must be valid JSON.");
        return;
      }
      const parsed = clientMessageSchema.safeParse(decoded);
      if (!parsed.success) {
        sendError(socket, "INVALID_MESSAGE", "Message does not match the protocol.");
        return;
      }
      void (async () => {
        try {
          const message = parsed.data;
          if (message.type === "join") {
            if (context || joining)
              throw new HttpError(409, "INVALID_MESSAGE", "This connection has already joined a room.");
            joining = true;
            try {
              const authenticatedSession = auth.authenticate(message.payload.accessToken);
              const joined = await rooms.join(
                message.payload.roomCode,
                message.payload.name,
                message.payload.playerId,
                message.payload.token,
                socket,
                authenticatedSession,
              );
              if (!auth.isActive(authenticatedSession)) {
                await rooms.disconnected(joined.room, joined.player, socket);
                socket.close(4003, "Access revoked");
                return;
              }
              session = authenticatedSession;
              auth.registerSocket(authenticatedSession, socket);
              clearTimeout(authTimeout);
              context = { room: joined.room, player: joined.player, session: authenticatedSession };
              send(socket, {
                type: "joined",
                payload: { playerId: joined.player.id, token: joined.token, roomCode: joined.room.code },
              });
              await rooms.publish(joined.room);
              return;
            } finally {
              joining = false;
            }
          }
          if (!context) throw new HttpError(401, "INVALID_MESSAGE", "Join a room before sending messages.");
          if (!auth.isActive(context.session)) {
            socket.close(4003, "Access revoked");
            return;
          }
          const activeContext = context;
          await rooms.handle(
            activeContext.room,
            activeContext.player,
            socket,
            message as { type: string; payload: Record<string, unknown> },
            () => auth.isActive(activeContext.session),
          );
        } catch (error) {
          if (error instanceof HttpError) sendError(socket, error.code, error.message);
          else sendError(socket, "INVALID_ACTION", "The action could not be completed.");
        }
      })();
    });
    socket.on("close", () => {
      clearTimeout(authTimeout);
      if (session) auth.unregisterSocket(session, socket);
      if (context) {
        void rooms.disconnected(context.room, context.player, socket).catch(() => undefined);
        context = null;
      }
    });
    socket.on("error", () => {
      // Socket errors are handled by the close lifecycle.
    });
  });

  const heartbeat = setInterval(() => {
    for (const rawSocket of sockets.clients) {
      const socket = rawSocket as SocketWithHealth;
      if (socket.readyState !== WebSocket.OPEN) continue;
      if (socket.isAlive === false) {
        socket.terminate();
        continue;
      }
      socket.isAlive = false;
      socket.ping();
    }
  }, 30_000);
  heartbeat.unref();
  const gameTicker = setInterval(() => {
    void rooms.tick().catch(() => undefined);
  }, 1000);
  gameTicker.unref();
  return {
    close: async () => {
      clearInterval(heartbeat);
      clearInterval(gameTicker);
      for (const socket of sockets.clients) socket.close(1001, "Server shutting down");
      await new Promise<void>((resolve) => sockets.close(() => resolve()));
    },
  };
}

function sendError(socket: WebSocket, code: string, message: string): void {
  send(socket, { type: "error", payload: { code, message } });
}
