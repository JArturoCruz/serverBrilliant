import "dotenv/config";
import { randomUUID } from "node:crypto";
import cors from "cors";
import express from "express";
import helmet from "helmet";
import { toNodeHandler } from "better-auth/node";
import { auth, database } from "./auth.js";
import {
  MultiplayerError,
  MultiplayerService,
  type MultiplayerUser,
} from "./multiplayer.js";

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
const multiplayerService = new MultiplayerService();
const multiplayerSweep = setInterval(() => multiplayerService.sweep(), 5_000);
multiplayerSweep.unref();

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
app.use(express.json({ limit: "16kb" }));

const multiplayer = express.Router();

async function authenticatedUser(
  request: express.Request,
): Promise<MultiplayerUser> {
  const authorization = request.get("authorization");
  if (!authorization) {
    throw new MultiplayerError("UNAUTHORIZED", "Inicia sesión para continuar.", 401);
  }
  const headers = new Headers();
  headers.set("authorization", authorization);
  const session = await auth.api.getSession({ headers });
  if (!session) {
    throw new MultiplayerError("UNAUTHORIZED", "Tu sesión expiró. Inicia sesión nuevamente.", 401);
  }
  return { id: session.user.id, name: session.user.name };
}

function requestObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new MultiplayerError("INVALID_REQUEST", "El cuerpo de la solicitud no es válido.", 400);
  }
  return value as Record<string, unknown>;
}

function requestPosition(value: unknown): { row: number; column: number } {
  const position = requestObject(value);
  if (!Number.isInteger(position.row) || !Number.isInteger(position.column)) {
    throw new MultiplayerError("INVALID_MOVE", "Las coordenadas no son válidas.", 400);
  }
  return { row: position.row as number, column: position.column as number };
}

multiplayer.get("/lobby", async (request, response) => {
  response.json(multiplayerService.listLobby(await authenticatedUser(request)));
});

multiplayer.post("/rooms", async (request, response) => {
  const body = requestObject(request.body);
  response.status(201).json(
    multiplayerService.createRoom(
      await authenticatedUser(request),
      typeof body.mapId === "number" ? body.mapId : Number.NaN,
    ),
  );
});

multiplayer.post("/rooms/:code/join", async (request, response) => {
  response.json(
    multiplayerService.joinRoom(
      await authenticatedUser(request),
      request.params.code ?? "",
    ),
  );
});

multiplayer.get("/rooms/:code", async (request, response) => {
  response.json(
    multiplayerService.getRoom(
      await authenticatedUser(request),
      request.params.code ?? "",
    ),
  );
});

multiplayer.post("/rooms/:code/start", async (request, response) => {
  response.json(
    multiplayerService.startRoom(
      await authenticatedUser(request),
      request.params.code ?? "",
    ),
  );
});

multiplayer.post("/rooms/:code/setup", async (request, response) => {
  const body = requestObject(request.body);
  if (
    !Array.isArray(body.values) ||
    body.values.some((value) => !Number.isInteger(value))
  ) {
    throw new MultiplayerError("INVALID_INITIAL_BOARD", "La configuración inicial no es válida.", 400);
  }
  response.json(
    multiplayerService.submitInitialBoard(
      await authenticatedUser(request),
      request.params.code ?? "",
      body.values as number[],
    ),
  );
});

multiplayer.post("/rooms/:code/skip", async (request, response) => {
  const body = requestObject(request.body);
  if (!Number.isInteger(body.round)) {
    throw new MultiplayerError("INVALID_REQUEST", "La ronda no es válida.", 400);
  }
  response.json(
    multiplayerService.skipRound(
      await authenticatedUser(request),
      request.params.code ?? "",
      body.round as number,
    ),
  );
});

multiplayer.post("/rooms/:code/leave", async (request, response) => {
  response.json(
    multiplayerService.leaveRoom(
      await authenticatedUser(request),
      request.params.code ?? "",
    ),
  );
});

multiplayer.post("/rooms/:code/move", async (request, response) => {
  const body = requestObject(request.body);
  if (
    typeof body.commandId !== "string" ||
    !/^[0-9a-f-]{36}$/i.test(body.commandId) ||
    !Number.isInteger(body.round) ||
    !Number.isInteger(body.anchorDieIndex)
  ) {
    throw new MultiplayerError("INVALID_MOVE", "Los datos de la jugada no son válidos.", 400);
  }
  response.json(
    multiplayerService.playMove(
      await authenticatedUser(request),
      request.params.code ?? "",
      {
        commandId: body.commandId,
        round: body.round as number,
        anchorDieIndex: body.anchorDieIndex as number,
        anchor: requestPosition(body.anchor),
        destination: requestPosition(body.destination),
      },
    ),
  );
});

app.use("/api/multiplayer", multiplayer);
app.use((
  error: unknown,
  request: express.Request,
  response: express.Response,
  _next: express.NextFunction,
) => {
  if (error instanceof MultiplayerError) {
    response.status(error.statusCode).json({ code: error.code, message: error.message });
    return;
  }
  const parserStatus =
    typeof error === "object" && error !== null && "status" in error
      ? Reflect.get(error, "status")
      : undefined;
  if (parserStatus === 400 || parserStatus === 413) {
    response.status(parserStatus).json({
      code: parserStatus === 413 ? "REQUEST_TOO_LARGE" : "INVALID_JSON",
      message: parserStatus === 413
        ? "La solicitud supera el tamaño permitido."
        : "El cuerpo JSON no es válido.",
    });
    return;
  }
  console.error(JSON.stringify({
    event: "http.request.error",
    requestId: response.getHeader("x-request-id"),
    path: request.path.startsWith("/api/multiplayer/") ? "/api/multiplayer/:other" : "/:other",
    errorType: error instanceof Error ? error.name : "UnknownError",
  }));
  response.status(500).json({
    code: "INTERNAL_SERVER_ERROR",
    message: "No se pudo completar la solicitud. Inténtalo de nuevo.",
  });
});

const server = app.listen(port, "0.0.0.0", () => {
  console.info(`Brilliant Auth Server escuchando en el puerto ${port}.`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    clearInterval(multiplayerSweep);
    server.close((error) => {
      if (error) {
        console.error("No se pudo cerrar el servidor correctamente.", error);
        process.exitCode = 1;
      }

      database.close();
    });
  });
}