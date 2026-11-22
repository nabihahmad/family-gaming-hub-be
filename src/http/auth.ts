import express, { type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import type { AuthService } from "../auth/AuthService.js";
import { getBearerToken } from "../auth/AuthService.js";
import { HttpError } from "../util/errors.js";

const loginSchema = z
  .object({
    username: z.string().trim().min(1).max(80),
    password: z.string().min(1).max(256),
  })
  .strict();
const accessCodeSchema = z.object({ code: z.string().regex(/^[A-HJ-NP-Z2-9]{8}$/i) }).strict();
const maxAttempts = 20;
const attemptWindowMs = 15 * 60_000;

export function createAuthRouter(auth: AuthService) {
  const router = express.Router();
  const attempts = new Map<string, { startedAt: number; count: number }>();
  const limitAttempts: express.RequestHandler = (req, _res, next) => {
    const key = req.ip || req.socket.remoteAddress || "unknown";
    const now = Date.now();
    if (attempts.size >= 10_000) {
      for (const [address, entry] of attempts) {
        if (now - entry.startedAt >= attemptWindowMs) attempts.delete(address);
      }
    }
    const current = attempts.get(key);
    if (!current || now - current.startedAt >= attemptWindowMs) {
      attempts.set(key, { startedAt: now, count: 1 });
      next();
      return;
    }
    if (current.count >= maxAttempts) {
      next(new HttpError(429, "RATE_LIMITED", "Too many sign-in attempts. Try again later."));
      return;
    }
    current.count++;
    next();
  };

  router.post(
    "/login",
    limitAttempts,
    asyncRoute(async (req, res) => {
      const input = loginSchema.parse(req.body);
      const result = await auth.login(input.username, input.password);
      res.json({ ...result, role: "admin" });
    }),
  );
  router.post(
    "/guest",
    limitAttempts,
    asyncRoute(async (req, res) => {
      const { code } = accessCodeSchema.parse(req.body);
      res.json({ ...auth.redeemAccessCode(code), role: "guest" });
    }),
  );
  router.get(
    "/me",
    asyncRoute(async (req, res) => {
      const session = auth.authenticate(getBearerToken(req.header("authorization")));
      res.json(auth.publicSession(session));
    }),
  );
  router.post(
    "/logout",
    asyncRoute(async (req, res) => {
      const session = auth.authenticate(getBearerToken(req.header("authorization")));
      auth.logout(session);
      res.json({ ok: true });
    }),
  );

  return router;
}

function asyncRoute(handler: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => {
    void handler(req, res).catch(next);
  };
}
