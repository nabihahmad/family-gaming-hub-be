import cors from "cors";
import express, { type NextFunction, type Request, type Response, type Router } from "express";
import type { AuthService } from "../auth/AuthService.js";
import { getBearerToken } from "../auth/AuthService.js";
import type { CardCache } from "../cards/cache.js";
import { createRoomBodySchema, packQuerySchema } from "../protocol/schemas.js";
import type { RoomManager } from "../rooms/RoomManager.js";
import { HttpError } from "../util/errors.js";

export function createHttpApp(
  rooms: RoomManager,
  cache: CardCache,
  allowedOrigins: string[],
  adminRouter: Router,
  auth: AuthService,
  authRouter: Router,
) {
  const app = express();
  app.use(
    cors({
      origin: (origin, callback) => {
        if (!origin || allowedOrigins.includes(origin)) callback(null, true);
        else callback(new HttpError(403, "ORIGIN_NOT_ALLOWED", "Origin is not allowed."));
      },
      optionsSuccessStatus: 200,
    }),
  );
  app.use(express.json({ limit: "1mb" }));

  app.get("/health", (_req, res) => res.json({ ok: true }));
  app.use("/api/auth", authRouter);
  app.post("/api/rooms", (req, res, next) => {
    try {
      createRoomBodySchema.parse(req.body ?? {});
      const session = auth.authenticate(getBearerToken(req.header("authorization")));
      if (session.role !== "admin") throw new HttpError(403, "ADMIN_ONLY", "Only the admin can create rooms.");
      res.status(201).json({ code: rooms.createRoom(session.userId).code });
    } catch (error) {
      next(error);
    }
  });
  app.get("/api/rooms/:code", (req, res, next) => {
    if (!/^[A-HJ-NP-Z2-9]{4}$/i.test(req.params.code)) {
      next(new HttpError(400, "INVALID_ROOM_CODE", "Room code is invalid."));
      return;
    }
    try {
      auth.authenticate(getBearerToken(req.header("authorization")));
      res.json(rooms.getPublicStatus(req.params.code));
    } catch (error) {
      next(error);
    }
  });
  app.get("/api/packs", (req, res, next) => {
    try {
      auth.authenticate(getBearerToken(req.header("authorization")));
      const { game, lang } = packQuerySchema.parse(req.query);
      res.json(cache.listPacks(game, lang));
    } catch (error) {
      next(error);
    }
  });
  app.use("/api/admin", adminRouter);

  app.use((_req, _res, next) => next(new HttpError(404, "NOT_FOUND", "Not found.")));
  app.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) {
      next(error);
      return;
    }
    if (error instanceof HttpError) {
      res.status(error.status).json({ error: error.code, message: error.message });
      return;
    }
    if (error instanceof Error && error.name === "ZodError") {
      res.status(400).json({ error: "INVALID_REQUEST", message: "Request validation failed." });
      return;
    }
    if (error instanceof Error && "status" in error && typeof error.status === "number" && error.status < 500) {
      res.status(error.status).json({ error: "INVALID_REQUEST", message: "Request validation failed." });
      return;
    }
    console.error("HTTP request failed.");
    res.status(500).json({ error: "INTERNAL_ERROR", message: "Internal server error." });
  });
  return app;
}
