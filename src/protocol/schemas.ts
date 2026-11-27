import { z } from "zod";

const gameId = z.enum(["codenames", "imposter", "werewolves"]);
const lang = z.enum(["en", "ar"]);
const baseOptions = z
  .object({
    lang,
    packs: z.array(z.string().min(1).max(40)).max(10).optional(),
    imposters: z.number().int().min(1).max(3).optional(),
    roles: z.array(z.string().min(1).max(32)).max(18).optional(),
    nightDiscoveries: z.boolean().optional(),
  })
  .strict();

export const clientMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("join"),
    payload: z
      .object({
        roomCode: z.string().regex(/^[A-HJ-NP-Z2-9]{4}$/i),
        name: z.string().min(1).max(100),
        accessToken: z.string().min(20).max(256),
        playerId: z.string().uuid().optional(),
        token: z.string().min(16).max(256).optional(),
      })
      .strict(),
  }),
  z.object({
    type: z.literal("select_game"),
    payload: z.object({ game: gameId, options: baseOptions }).strict(),
  }),
  z.object({ type: z.literal("start_game"), payload: z.object({}).strict() }),
  z.object({
    type: z.literal("game_event"),
    payload: z
      .object({
        name: z.string().min(1).max(40),
        data: z.record(z.string(), z.unknown()).optional(),
      })
      .strict(),
  }),
  z.object({ type: z.literal("back_to_lobby"), payload: z.object({}).strict() }),
  z.object({ type: z.literal("ping"), payload: z.object({}).strict() }),
]);

export const createRoomBodySchema = z.object({}).strict();
export const packQuerySchema = z.object({
  game: z.enum(["codenames", "imposter"]),
  lang,
});
