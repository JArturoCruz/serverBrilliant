import type { DatabaseSync } from "node:sqlite";

const USERNAME_PATTERN =
  /^[\p{L}\p{N}][\p{L}\p{M}\p{N}]*(?:[ '\u2019-][\p{L}\p{N}][\p{L}\p{M}\p{N}]*)*$/u;

export function normalizeUsername(name: string): string {
  return name.trim().normalize("NFKC").toLowerCase();
}

export function isValidUsername(name: string): boolean {
  const normalized = normalizeUsername(name);
  const characterCount = Array.from(normalized).length;
  return (
    characterCount >= 2 &&
    characterCount <= 32 &&
    USERNAME_PATTERN.test(normalized)
  );
}

export function registerUsernameNormalizer(database: DatabaseSync): void {
  database.function(
    "normalize_user_name",
    { deterministic: true },
    (value) => (typeof value === "string" ? normalizeUsername(value) : ""),
  );
}

export function ensureUniqueUsernameIndex(database: DatabaseSync): void {
  database.exec(
    "CREATE UNIQUE INDEX IF NOT EXISTS user_name_normalized_unique " +
      "ON user (normalize_user_name(name))",
  );
}

export function usernameIsTaken(database: DatabaseSync, name: string): boolean {
  return Boolean(
    database
      .prepare(
        "SELECT id FROM user WHERE normalize_user_name(name) = " +
          "normalize_user_name(?) LIMIT 1",
      )
      .get(name),
  );
}
