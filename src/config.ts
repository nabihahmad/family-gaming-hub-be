import "dotenv/config";
import { z } from "zod";

const configSchema = z
  .object({
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    MONGODB_URI: z.string().min(1),
    MONGODB_DB: z.string().min(1),
    ALLOWED_ORIGINS: z.string().default("http://localhost:5173"),
    ADMIN_TOKEN: z.string().min(32),
    ADMIN_USERNAME: z
      .string()
      .trim()
      .min(3)
      .max(80)
      .transform((value) => value.toLocaleLowerCase()),
    ADMIN_PASSWORD: z.string().min(12).max(256),
    CARD_CACHE_TTL_SECONDS: z.coerce.number().int().min(30).max(86400).default(300),
    CODENAMES_SPYMASTER_INITIAL_SECONDS: z.coerce.number().int().min(1).max(3600).default(120),
    CODENAMES_SPYMASTER_ROUND_DECREMENT_SECONDS: z.coerce.number().int().min(0).max(3600).default(15),
    CODENAMES_SPYMASTER_MINIMUM_SECONDS: z.coerce.number().int().min(1).max(3600).default(15),
    CODENAMES_GUESSER_SECONDS_PER_WORD: z.coerce.number().int().min(1).max(3600).default(30),
  })
  .refine((values) => values.CODENAMES_SPYMASTER_MINIMUM_SECONDS <= values.CODENAMES_SPYMASTER_INITIAL_SECONDS, {
    path: ["CODENAMES_SPYMASTER_MINIMUM_SECONDS"],
    message: "Must not exceed the initial spymaster time.",
  });

const parsed = configSchema.safeParse(process.env);
if (!parsed.success) {
  throw new Error(
    `Invalid environment configuration: ${parsed.error.issues.map((issue) => issue.path.join(".")).join(", ")}`,
  );
}

export const config = {
  port: parsed.data.PORT,
  mongoUri: parsed.data.MONGODB_URI,
  mongoDb: parsed.data.MONGODB_DB,
  allowedOrigins: parsed.data.ALLOWED_ORIGINS.split(",")
    .map((item) => item.trim())
    .filter(Boolean),
  adminToken: parsed.data.ADMIN_TOKEN,
  adminUsername: parsed.data.ADMIN_USERNAME,
  adminPassword: parsed.data.ADMIN_PASSWORD,
  cardCacheTtlMs: parsed.data.CARD_CACHE_TTL_SECONDS * 1000,
  codenamesTimers: {
    spymasterInitialMs: parsed.data.CODENAMES_SPYMASTER_INITIAL_SECONDS * 1000,
    spymasterRoundDecrementMs: parsed.data.CODENAMES_SPYMASTER_ROUND_DECREMENT_SECONDS * 1000,
    spymasterMinimumMs: parsed.data.CODENAMES_SPYMASTER_MINIMUM_SECONDS * 1000,
    guesserMsPerWord: parsed.data.CODENAMES_GUESSER_SECONDS_PER_WORD * 1000,
  },
};
