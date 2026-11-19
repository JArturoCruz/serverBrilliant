import "dotenv/config";
import { DatabaseSync } from "node:sqlite";
import { betterAuth } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { getMigrations } from "better-auth/db/migration";
import { bearer, username } from "better-auth/plugins";
import {
  ensureUniqueUsernameIndex,
  isValidUsername,
  normalizeUsername,
  registerUsernameNormalizer,
  usernameIsTaken,
} from "./auth-username.js";

const baseURL = process.env.BETTER_AUTH_URL;
const secret = process.env.BETTER_AUTH_SECRET;
const databasePath = process.env.SQLITE_PATH ?? "./brilliant-auth.sqlite";

if (!baseURL) {
  throw new Error("Falta BETTER_AUTH_URL en .env");
}

if (!secret || secret.length < 32) {
  throw new Error("BETTER_AUTH_SECRET debe tener al menos 32 caracteres.");
}

export const database = new DatabaseSync(databasePath);

database.exec("PRAGMA journal_mode = WAL;");
database.exec("PRAGMA foreign_keys = ON;");
registerUsernameNormalizer(database);

const trustedOrigins = (process.env.CLIENT_ORIGINS ?? "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

export const auth = betterAuth({
  database,
  baseURL,
  secret,
  trustedOrigins,
  emailAndPassword: {
    enabled: true,
    minPasswordLength: 6,
    maxPasswordLength: 128,
  },
  rateLimit: {
    enabled: true,
    window: 60,
    max: 100,
    customRules: {
      "/sign-in/email": { window: 15 * 60, max: 8 },
      "/sign-in/username": { window: 15 * 60, max: 8 },
      "/sign-up/email": { window: 60 * 60, max: 5 },
    },
  },
  databaseHooks: {
    user: {
      create: {
        before: async (user) => {
          const name = user.name.trim();
          if (!isValidUsername(name)) {
            throw new APIError("BAD_REQUEST", {
              message:
                "El nombre debe tener entre 2 y 32 caracteres y usar solo letras, números, espacios, guiones o apóstrofes.",
            });
          }

          ensureUniqueUsernameIndex(database);
          if (usernameIsTaken(database, name)) {
            throw new APIError("CONFLICT", {
              message: "Ese nombre de usuario ya está en uso.",
            });
          }

          return { data: { ...user, name } };
        },
      },
    },
  },
  user: {
    deleteUser: { enabled: true },
  },
  plugins: [
    bearer(),
    username({
      minUsernameLength: 2,
      maxUsernameLength: 32,
      usernameValidator: isValidUsername,
      usernameNormalization: normalizeUsername,
      displayUsername: false,
      immutableUsername: true,
    }),
    {
      id: "brilliant-registration",
      hooks: {
        before: [{
          matcher: (context) => context.path === "/sign-up/email",
          handler: createAuthMiddleware(async (context) => {
            const { name, username: login, password } = context.body;
            if (typeof name !== "string" || typeof login !== "string" ||
                normalizeUsername(name) !== normalizeUsername(login)) {
              throw new APIError("BAD_REQUEST", { message: "El nombre de usuario no es válido." });
            }
            if (typeof password !== "string" || !/^[0-9]{6}$/.test(password)) {
              throw new APIError("BAD_REQUEST", { message: "El PIN debe contener exactamente 6 dígitos." });
            }
          }),
        }],
      },
    },
  ],
});

export async function initializeDatabase(): Promise<void> {
  const table = database.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' LIMIT 1",
  ).get();
  if (!table) {
    const migrations = await getMigrations(auth.options);
    await migrations.runMigrations();
  } else {
    const columns = database.prepare("PRAGMA table_info(user)").all();
    if (!columns.some((column) => column.name === "username")) {
      database.exec("BEGIN IMMEDIATE");
      try {
        ensureUniqueUsernameIndex(database);
        database.exec("ALTER TABLE user ADD COLUMN username TEXT");
        database.exec("UPDATE user SET username = normalize_user_name(name)");
        database.exec("CREATE UNIQUE INDEX user_username_unique ON user(username)");
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    }
  }
}