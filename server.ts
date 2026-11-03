import "dotenv/config";
import { randomUUID } from "node:crypto";
import cors from "cors";
import express from "express";
import helmet from "helmet";
import { toNodeHandler } from "better-auth/node";
import { auth, database } from "./auth.js";

const app = express();
const port = Number.parseInt(process.env.PORT ?? "3000", 10);

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("PORT no es válido.");
}

const clientOrigins = (process.env.CLIENT_ORIGINS ?? "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

const requestIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const tracedAuthPaths = new Set([
  "/api/auth/sign-up/email",
  "/api/auth/sign-in/email",
  "/api/auth/get-session",
  "/api/auth/sign-out",
  "/api/auth/delete-user",
]);

app.use(helmet());

app.use((request, response, next) => {
  const suppliedId = request.get("x-request-id");
  const requestId =
    suppliedId && requestIdPattern.test(suppliedId) ? suppliedId : randomUUID();
  const startedAt = process.hrtime.bigint();
  response.setHeader("x-request-id", requestId);
  response.on("finish", () => {
    const path = tracedAuthPaths.has(request.path)
      ? request.path
      : request.path.startsWith("/api/auth/")
        ? "/api/auth/:other"
        : request.path === "/health"
          ? "/health"
          : "/:other";
    console.info(
      JSON.stringify({
        event: "http.request",
        timestamp: new Date().toISOString(),
        requestId,
        method: request.method,
        path,
        statusCode: response.statusCode,
        durationMs: Number((process.hrtime.bigint() - startedAt) / 1_000_000n),
      }),
    );
  });
  next();
});

app.use(
  cors({
    origin: clientOrigins.length > 0 ? clientOrigins : false,
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Request-Id"],
    exposedHeaders: ["set-auth-token", "x-request-id", "x-retry-after"],
  }),
);

app.get("/health", (_request, response) => {
  response.json({ status: "ok" });
});

// Better Auth debe recibir sus solicitudes antes de otros manejadores de body.
app.all("/api/auth/*splat", toNodeHandler(auth));

const server = app.listen(port, "0.0.0.0", () => {
  console.info(`Brilliant Auth Server escuchando en el puerto ${port}.`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    server.close((error) => {
      if (error) {
        console.error("No se pudo cerrar el servidor correctamente.", error);
        process.exitCode = 1;
      }

      database.close();
    });
  });
}