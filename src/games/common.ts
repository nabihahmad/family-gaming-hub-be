export class GameRuleError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "GameRuleError";
  }
}

export function requireRule(condition: unknown, code: string, message: string): asserts condition {
  if (!condition) throw new GameRuleError(code, message);
}

export function shuffle<T>(values: readonly T[], rng: () => number): T[] {
  const result = [...values];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [result[i], result[j]] = [result[j]!, result[i]!];
  }
  return result;
}

export function pick<T>(values: readonly T[], rng: () => number): T {
  requireRule(values.length > 0, "NOT_ENOUGH_CARDS", "No cards are available for this game.");
  return values[Math.floor(rng() * values.length)]!;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
