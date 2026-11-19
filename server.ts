import "dotenv/config";
import { randomUUID } from "node:crypto";
import { createSocket } from "node:dgram";
import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import cors from "cors";
import express from "express";
import helmet from "helmet";
import { toNodeHandler } from "better-auth/node";
import { auth, database, initializeDatabase } from "./auth.js";
import {
  MultiplayerError,
  MultiplayerService,
  type MultiplayerUser,
} from "./multiplayer.js";

const app = express();
const port = Number.parseInt(process.env.PORT ?? "3000", 10);
const discoveryPort = Number.parseInt(process.env.DISCOVERY_PORT ?? "38971", 10);
const webRoot = process.env.BRILLIANT_WEB_ROOT?.trim();

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("PORT no es válido.");
}
if (!Number.isInteger(discoveryPort) || discoveryPort < 1 || discoveryPort > 65535) {
  throw new Error("DISCOVERY_PORT no es válido.");
}
if (webRoot && (!isAbsolute(webRoot) || !existsSync(join(webRoot, "index.html")))) {
  throw new Error("BRILLIANT_WEB_ROOT debe ser una ruta absoluta con una compilación web válida.");
}

const clientOrigins = (process.env.CLIENT_ORIGINS ?? "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

const corsOrigin = clientOrigins.includes("*") ? true : clientOrigins.length > 0 ? clientOrigins : false;

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

app.use((request, response, next) => {
  if (request.method === "OPTIONS" && request.get("access-control-request-private-network") === "true") {
    response.vary("Access-Control-Request-Private-Network");
    const origin = request.get("origin");
    if (origin && (clientOrigins.includes("*") || clientOrigins.includes(origin))) {
      response.setHeader("Access-Control-Allow-Private-Network", "true");
    }
  }
  next();
});

app.use(
  cors({
    origin: corsOrigin,
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Request-Id", "ngrok-skip-browser-warning"],
    exposedHeaders: ["set-auth-token", "x-request-id", "x-retry-after"],
  }),
);

app.get("/health", (request, response) => {
  console.log("Health check received from:", request.headers.origin);
  response.json({ status: "ok", service: "brilliant" });
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

multiplayer.post("/rooms/:code/ready", async (request, response) => {
  const body = requestObject(request.body);
  if (typeof body.ready !== "boolean") {
    throw new MultiplayerError("INVALID_REQUEST", "Indica si estás listo.", 400);
  }
  response.json(multiplayerService.setReady(
    await authenticatedUser(request),
    request.params.code ?? "",
    body.ready,
  ));
});

multiplayer.post("/rooms/:code/remove-player", async (request, response) => {
  const body = requestObject(request.body);
  if (typeof body.playerId !== "string" || body.playerId.length === 0 || typeof body.block !== "boolean") {
    throw new MultiplayerError("INVALID_REQUEST", "Indica el jugador y la acción.", 400);
  }
  response.json(multiplayerService.removeRoomPlayer(
    await authenticatedUser(request),
    request.params.code ?? "",
    body.playerId,
    body.block,
  ));
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
if (webRoot) {
  app.use(
    helmet.contentSecurityPolicy({
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'wasm-unsafe-eval'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:", "blob:"],
        fontSrc: ["'self'", "data:"],
        connectSrc: ["'self'", "https:", "http:", "wss:", "ws:"],
        workerSrc: ["'self'", "blob:"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        frameAncestors: ["'none'"],
      },
    }),
    express.static(webRoot, { index: "index.html", fallthrough: true }),
  );
}
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

await initializeDatabase();

const server = app.listen(port, "0.0.0.0", () => {
  console.info(`Brilliant Auth Server escuchando en el puerto ${port}.`);
});

const discovery = createSocket("udp4");
let discoveryListening = false;
discovery.on("listening", () => { discoveryListening = true; });
discovery.on("close", () => { discoveryListening = false; });
discovery.on("error", (error) => {
  console.error("La búsqueda de servidores en la red local no está disponible:", error.message);
  if (discoveryListening) discovery.close();
});
discovery.on("message", (message, remote) => {
  const match = /^BRILLIANT_DISCOVER_V1:([0-9a-f]{32})$/.exec(message.toString("utf8"));
  if (!match) return;
  discovery.send(`BRILLIANT_SERVER_V1:${match[1]}:${port}`, remote.port, remote.address, (error) => {
    if (error) console.error("No se pudo responder a la búsqueda de servidor:", error.message);
  });
});
discovery.bind(discoveryPort, "0.0.0.0");

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    clearInterval(multiplayerSweep);
    if (discoveryListening) discovery.close();
    server.close((error) => {
      if (error) {
        console.error("No se pudo cerrar el servidor correctamente.", error);
        process.exitCode = 1;
      }

      database.close();
    });
  });
}