import { createHash, timingSafeEqual } from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import { ObjectId } from "mongodb";
import { z } from "zod";
import type { CardCache } from "../cards/cache.js";
import { normalizeWord } from "../cards/normalize.js";
import type { CardCollections } from "../cards/repo.js";
import type { CardDocument, GameId } from "../protocol/types.js";
import { HttpError } from "../util/errors.js";

const cardFieldsSchema = z
  .object({
    pack: z.string().min(1).max(40),
    games: z
      .array(z.enum(["codenames", "imposter", "werewolves"]))
      .min(1)
      .refine((games) => new Set(games).size === games.length, "Game IDs must be unique."),
    en: z.object({ word: z.string().trim().min(1).max(80), hint: z.string().trim().max(80).optional() }).optional(),
    ar: z.object({ word: z.string().trim().min(1).max(80), hint: z.string().trim().max(80).optional() }).optional(),
  })
  .strict();
const cardInputSchema = cardFieldsSchema.refine((value) => value.en || value.ar, "At least one language is required.");

const packInputSchema = z
  .object({
    _id: z.string().min(1).max(40),
    name: z.object({ en: z.string().trim().min(1).max(80), ar: z.string().trim().min(1).max(80) }).strict(),
    games: z
      .array(z.enum(["codenames", "imposter", "werewolves"]))
      .min(1)
      .refine((games) => new Set(games).size === games.length, "Game IDs must be unique."),
    active: z.boolean().default(true),
  })
  .strict();

export function createAdminRouter(repository: CardCollections, cache: CardCache, adminToken: string) {
  const router = express.Router();
  router.use((req, _res, next) => {
    const header = req.header("authorization") ?? "";
    const supplied = /^Bearer (.+)$/i.exec(header)?.[1] ?? "";
    const expectedHash = createHash("sha256").update(adminToken).digest();
    const suppliedHash = createHash("sha256").update(supplied).digest();
    if (!timingSafeEqual(expectedHash, suppliedHash)) {
      next(new HttpError(401, "UNAUTHORIZED", "A valid admin bearer token is required."));
      return;
    }
    next();
  });

  router.get(
    "/cards",
    asyncRoute(async (req, res) => {
      const querySchema = z.object({
        pack: z.string().optional(),
        game: z.enum(["codenames", "imposter", "werewolves"]).optional(),
        q: z.string().max(80).optional(),
        page: z.coerce.number().int().min(1).default(1),
        limit: z.coerce.number().int().min(1).max(100).default(50),
      });
      const query = querySchema.parse(req.query);
      const filter: Record<string, unknown> = {};
      if (query.pack) filter.pack = query.pack;
      if (query.game) filter.games = query.game;
      if (query.q) {
        const escaped = query.q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        filter.$or = [{ "en.word": { $regex: escaped, $options: "i" } }, { "ar.word": { $regex: escaped } }];
      }
      const [items, total] = await Promise.all([
        repository.cards
          .find(filter)
          .sort({ pack: 1, enNorm: 1 })
          .skip((query.page - 1) * query.limit)
          .limit(query.limit)
          .toArray(),
        repository.cards.countDocuments(filter),
      ]);
      res.json({ items, page: query.page, limit: query.limit, total });
    }),
  );

  router.post(
    "/cards",
    asyncRoute(async (req, res) => {
      const input = cardInputSchema.parse(req.body);
      await assertCompatiblePack(repository, input);
      const document = cardDocument(input);
      try {
        const result = await repository.cards.insertOne(document);
        if (!(await cache.refresh()))
          throw new HttpError(503, "CACHE_REFRESH_FAILED", "Card saved, but the game cache could not be refreshed.");
        res.status(201).json({ ...document, _id: result.insertedId });
      } catch (error) {
        if (isDuplicate(error)) throw new HttpError(409, "DUPLICATE_CARD", "A card with this word already exists.");
        throw error;
      }
    }),
  );

  router.put(
    "/cards/:id",
    asyncRoute(async (req, res) => {
      const id = z
        .string()
        .regex(/^[0-9a-f]{24}$/i)
        .parse(req.params.id);
      if (!ObjectId.isValid(id)) throw new HttpError(400, "INVALID_ID", "Card ID is invalid.");
      const updateSchema = cardFieldsSchema
        .partial()
        .extend({ active: z.boolean().optional() })
        .strict()
        .refine((value) => Object.keys(value).length > 0, "At least one field is required.");
      const patch = updateSchema.parse(req.body);
      const existing = await repository.cards.findOne({ _id: new ObjectId(id) });
      if (!existing) throw new HttpError(404, "NOT_FOUND", "Card not found.");
      const merged = {
        pack: patch.pack ?? existing.pack,
        games: patch.games ?? existing.games,
        ...(patch.en ? { en: patch.en } : existing.en ? { en: existing.en } : {}),
        ...(patch.ar ? { ar: patch.ar } : existing.ar ? { ar: existing.ar } : {}),
        active: patch.active ?? existing.active,
      };
      await assertCompatiblePack(repository, merged);
      const document = cardDocument(merged);
      try {
        await repository.cards.updateOne(
          { _id: existing._id },
          { $set: { ...document, active: patch.active ?? existing.active, updatedAt: new Date() } },
        );
        if (!(await cache.refresh()))
          throw new HttpError(503, "CACHE_REFRESH_FAILED", "Card saved, but the game cache could not be refreshed.");
        res.json({ ...document, _id: existing._id, active: patch.active ?? existing.active });
      } catch (error) {
        if (isDuplicate(error)) throw new HttpError(409, "DUPLICATE_CARD", "A card with this word already exists.");
        throw error;
      }
    }),
  );

  router.delete(
    "/cards/:id",
    asyncRoute(async (req, res) => {
      const id = z
        .string()
        .regex(/^[0-9a-f]{24}$/i)
        .parse(req.params.id);
      if (!ObjectId.isValid(id)) throw new HttpError(400, "INVALID_ID", "Card ID is invalid.");
      const result = await repository.cards.updateOne(
        { _id: new ObjectId(id) },
        { $set: { active: false, updatedAt: new Date() } },
      );
      if (!result.matchedCount) throw new HttpError(404, "NOT_FOUND", "Card not found.");
      if (!(await cache.refresh()))
        throw new HttpError(
          503,
          "CACHE_REFRESH_FAILED",
          "Card deactivated, but the game cache could not be refreshed.",
        );
      res.json({ ok: true });
    }),
  );

  router.post(
    "/cards/import",
    asyncRoute(async (req, res) => {
      const rows = z.array(z.unknown()).max(1000).parse(req.body);
      const errors: Array<{ index: number; error: string }> = [];
      let imported = 0;
      for (const [index, row] of rows.entries()) {
        const parsed = cardInputSchema.safeParse(row);
        if (!parsed.success) {
          errors.push({ index, error: "invalid card data" });
          continue;
        }
        try {
          await assertCompatiblePack(repository, parsed.data);
          await repository.cards.insertOne(cardDocument(parsed.data));
          imported++;
        } catch (error) {
          errors.push({
            index,
            error: isDuplicate(error)
              ? "duplicate card"
              : error instanceof HttpError
                ? "invalid pack"
                : "could not import card",
          });
        }
      }
      if (!(await cache.refresh()))
        throw new HttpError(
          503,
          "CACHE_REFRESH_FAILED",
          "Import completed, but the game cache could not be refreshed.",
        );
      res.status(200).json({ imported, failed: errors.length, errors });
    }),
  );

  router.get(
    "/packs",
    asyncRoute(async (_req, res) => {
      res.json(await repository.packs.find({}).sort({ _id: 1 }).toArray());
    }),
  );

  router.post(
    "/packs",
    asyncRoute(async (req, res) => {
      const pack = packInputSchema.parse(req.body);
      try {
        await repository.packs.insertOne(pack);
      } catch (error) {
        if (isDuplicate(error)) throw new HttpError(409, "DUPLICATE_PACK", "A pack with this ID already exists.");
        throw error;
      }
      if (!(await cache.refresh()))
        throw new HttpError(503, "CACHE_REFRESH_FAILED", "Pack saved, but the game cache could not be refreshed.");
      res.status(201).json(pack);
    }),
  );

  router.put(
    "/packs/:id",
    asyncRoute(async (req, res) => {
      const id = z.string().min(1).max(40).parse(req.params.id);
      const pack = packInputSchema.omit({ _id: true }).parse(req.body);
      const result = await repository.packs.updateOne({ _id: id }, { $set: pack });
      if (!result.matchedCount) throw new HttpError(404, "NOT_FOUND", "Pack not found.");
      if (!(await cache.refresh()))
        throw new HttpError(503, "CACHE_REFRESH_FAILED", "Pack saved, but the game cache could not be refreshed.");
      res.json({ _id: id, ...pack });
    }),
  );

  router.post(
    "/reload",
    asyncRoute(async (_req, res) => {
      if (!(await cache.refresh()))
        throw new HttpError(503, "CACHE_REFRESH_FAILED", "The game cache could not be refreshed.");
      res.json({ ok: true });
    }),
  );

  return router;
}

function cardDocument(input: {
  pack: string;
  games: GameId[];
  en?: { word: string; hint?: string | undefined } | undefined;
  ar?: { word: string; hint?: string | undefined } | undefined;
  active?: boolean;
}): CardDocument {
  const document: CardDocument = {
    pack: input.pack,
    games: input.games,
    active: input.active ?? true,
    updatedAt: new Date(),
  };
  if (input.en) {
    document.en = input.en;
    document.enNorm = normalizeWord(input.en.word, "en");
  }
  if (input.ar) {
    document.ar = input.ar;
    document.arNorm = normalizeWord(input.ar.word, "ar");
  }
  return document;
}

async function assertCompatiblePack(
  repository: Pick<CardCollections, "packs">,
  input: { pack: string; games: GameId[] },
): Promise<void> {
  const pack = await repository.packs.findOne({ _id: input.pack });
  if (!pack || !pack.active || input.games.some((game) => !pack.games.includes(game))) {
    throw new HttpError(400, "INVALID_PACK", "The card must use an active pack that supports each selected game.");
  }
}

function isDuplicate(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === 11000;
}

function asyncRoute(handler: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => {
    void handler(req, res).catch(next);
  };
}
