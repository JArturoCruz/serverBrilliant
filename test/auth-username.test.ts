import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { afterEach, test } from "node:test";
import {
  ensureUniqueUsernameIndex,
  isValidUsername,
  normalizeUsername,
  registerUsernameNormalizer,
  usernameIsTaken,
} from "../auth-username.js";

const databases: DatabaseSync[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) {
    database.close();
  }
});

function createDatabase(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  database.exec("CREATE TABLE user (id TEXT PRIMARY KEY, name TEXT NOT NULL)");
  registerUsernameNormalizer(database);
  ensureUniqueUsernameIndex(database);
  databases.push(database);
  return database;
}

test("normalizes usernames consistently while preserving display spelling", () => {
  assert.equal(normalizeUsername("  ÁlEx  "), "álex");
});

test("accepts international names and common name separators", () => {
  for (const name of ["Álex", "李 小龍", "Jean-Luc", "O’Connor", "Player 2"]) {
    assert.equal(isValidUsername(name), true, name);
  }
});

test("rejects symbols, controls, and command-like usernames", () => {
  for (const name of [
    "+",
    "Alt + 64",
    "name; DROP TABLE user",
    "' OR 1=1 --",
    "name\nother",
    "A\u202eB",
  ]) {
    assert.equal(isValidUsername(name), false, name);
  }
});

test("NFKC normalization prevents compatibility symbols bypassing validation", () => {
  assert.equal(isValidUsername("Ａｌｅｘ"), true);
  assert.equal(isValidUsername("Ａｌｅｘ＋１"), false);
  assert.equal(isValidUsername("a".repeat(33)), false);
});

test("detects usernames ignoring case, surrounding spaces, and Unicode form", () => {
  const database = createDatabase();
  database.prepare("INSERT INTO user (id, name) VALUES (?, ?)").run("1", "Árbol");

  assert.equal(usernameIsTaken(database, "  árbol "), true);
  assert.equal(usernameIsTaken(database, "arbol"), false);
  assert.equal(usernameIsTaken(database, "' OR 1=1 --"), false);
  assert.equal(
    database.prepare("SELECT name FROM sqlite_master WHERE type = ?").get("table") !==
      undefined,
    true,
  );
  assert.throws(() =>
    database
      .prepare("INSERT INTO user (id, name) VALUES (?, ?)")
      .run("2", " árbol "),
  );
});
