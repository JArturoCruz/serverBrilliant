import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { afterEach, test } from "node:test";
import {
  ensureUniqueUsernameIndex,
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

test("detects usernames ignoring case, surrounding spaces, and Unicode form", () => {
  const database = createDatabase();
  database.prepare("INSERT INTO user (id, name) VALUES (?, ?)").run("1", "Árbol");

  assert.equal(usernameIsTaken(database, "  árbol "), true);
  assert.equal(usernameIsTaken(database, "arbol"), false);
  assert.throws(() =>
    database
      .prepare("INSERT INTO user (id, name) VALUES (?, ?)")
      .run("2", " árbol "),
  );
});
