import "dotenv/config";
import { DatabaseSync } from "node:sqlite";
import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { bearer } from "better-auth/plugins";
import {
  ensureUniqueUsernameIndex,
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
    minPasswordLength: 12,
    maxPasswordLength: 128,
  },
  rateLimit: {
    enabled: true,
    window: 60,
    max: 100,
    customRules: {
      "/sign-in/email": { window: 15 * 60, max: 8 },
      "/sign-up/email": { window: 60 * 60, max: 5 },
    },
  },
  databaseHooks: {
    user: {
      create: {
        before: async (user) => {
          const name = user.name.trim();
          const normalizedName = normalizeUsername(name);
          if (normalizedName.length < 2 || normalizedName.length > 32) {
            throw new APIError("BAD_REQUEST", {
              message: "El nombre de usuario debe tener entre 2 y 32 caracteres.",
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
  plugins: [bearer()],
});