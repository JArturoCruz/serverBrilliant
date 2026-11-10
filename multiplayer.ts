import { randomInt, randomUUID } from "node:crypto";

export interface MultiplayerUser {
  id: string;
  name: string;
}

type RoomPhase = "waiting" | "setup" | "playing" | "finished";
type Position = { row: number; column: number };
type Board = (number | null)[][];

interface Player {
  id: string;
  name: string;
  isHost: boolean;
  lastSeenAt: number;
  board: Board;
  ready: boolean;
  score: number;
  forfeited: boolean;
  completedRegions: Set<string>;
  playedThisRound: boolean;
}

interface RoomEvent {
  id: string;
  message: string;
  createdAt: string;
}

interface BoardRules {
  rows: string[];
  regionTypes: Record<string, "green" | "blue" | "yellow" | "red" | "purple" | "white" | "orangeHigh" | "orangeLow">;
  regionNames: Record<string, string>;
  points: Record<string, number[]>;
  initial: Position[];
}

interface Room {
  code: string;
  mapId: number;
  hostId: string;
  phase: RoomPhase;
  players: Player[];
  playerCountAtStart: number;
  dice: [number, number] | null;
  round: number;
  revision: number;
  regionCounters: Record<string, number>;
  regionLastClaimRound: Record<string, number>;
  winners: string[];
  finishReason: string | null;
  events: RoomEvent[];
  createdAt: number;
  finishedAt: number | null;
}

interface ClosedRoom {
  message: string;
  expiresAt: number;
}

export interface RoomSnapshot {
  code: string;
  mapId: number;
  phase: RoomPhase;
  hostId: string;
  players: Array<{
    id: string;
    name: string;
    isHost: boolean;
    connected: boolean;
    score: number;
    forfeited: boolean;
    isWinner: boolean;
    ready: boolean;
    playedThisRound: boolean;
  }>;
  board: Board;
  dice: [number, number] | null;
  round: number;
  scoreToWin: number;
  revision: number;
  winners: string[];
  finishReason: string | null;
  events: RoomEvent[];
  regionCounters: Record<string, number>;
}

export interface LobbySnapshot {
  activePlayers: Array<{ id: string; name: string }>;
  rooms: Array<{
    code: string;
    mapId: number;
    hostName: string;
    playerCount: number;
    connectedPlayerCount: number;
  }>;
}

const DISCONNECT_GRACE_MS = 60_000;
const PRESENCE_STALE_MS = 6_000;
const ROOM_RETENTION_MS = 10 * 60_000;
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const EMPTY_BOARD = () =>
  Array.from({ length: 7 }, () => Array<number | null>(7).fill(null));

const MAPS: Record<number, BoardRules> = {
  1: {
    rows: ["ygbpppy", "ggbbppg", "grrbpgg", "grqyhhh", "grqqssc", "rrqsscc", "yqqsscy"],
    regionTypes: { y: "yellow", g: "green", h: "green", b: "blue", c: "blue", p: "purple", q: "purple", r: "red", s: "red" },
    regionNames: { y: "amarilla", g: "verde1", h: "verde2", b: "azul1", c: "azul2", p: "morada1", q: "morada2", r: "roja1", s: "roja2" },
    points: { y: [8, 6, 4], g: [4, 3, 2], h: [4, 3, 2], b: [7, 5, 3], c: [7, 5, 3], p: [6, 4, 2], q: [6, 4, 2], r: [6, 4, 2], s: [6, 4, 2] },
    initial: [{ row: 0, column: 2 }, { row: 3, column: 1 }, { row: 1, column: 5 }, { row: 3, column: 4 }, { row: 5, column: 2 }, { row: 6, column: 4 }],
  },
  2: {
    rows: ["pppwggg", "pybbbyg", "prrbbsg", "rrrysss", "hrccssq", "hycccyq", "hhhwqqq"],
    regionTypes: { y: "yellow", g: "green", h: "green", b: "blue", c: "blue", p: "purple", q: "purple", r: "red", s: "red", w: "white" },
    regionNames: { y: "amarilla", g: "verde1", h: "verde2", b: "azul1", c: "azul2", p: "morada1", q: "morada2", r: "roja1", s: "roja2", w: "blanca" },
    points: { y: [6, 4, 2], g: [4, 3, 2], h: [4, 3, 2], b: [7, 5, 3], c: [7, 5, 3], p: [6, 4, 2], q: [6, 4, 2], r: [6, 4, 2], s: [6, 4, 2], w: [3, 2, 1] },
    initial: [{ row: 0, column: 4 }, { row: 2, column: 0 }, { row: 3, column: 2 }, { row: 4, column: 5 }, { row: 5, column: 1 }, { row: 6, column: 4 }],
  },
  3: {
    rows: ["yypwpyy", "wypppyw", "rrrpsss", "rrrwsss", "gbbbbbg", "ggggggg", "qqqwqqq"],
    regionTypes: { y: "yellow", g: "green", b: "blue", p: "purple", q: "purple", r: "red", s: "red", w: "white" },
    regionNames: { y: "amarilla", g: "verde1", b: "azul1", p: "morada1", q: "morada2", r: "roja1", s: "roja2", w: "blanca" },
    points: { y: [7, 5, 3], g: [6, 5, 4], b: [7, 5, 3], p: [7, 5, 3], q: [7, 5, 3], r: [6, 4, 2], s: [6, 4, 2], w: [8, 6, 4] },
    initial: [{ row: 1, column: 2 }, { row: 1, column: 5 }, { row: 3, column: 3 }, { row: 4, column: 1 }, { row: 4, column: 6 }, { row: 6, column: 2 }],
  },
  4: {
    rows: ["ooooooo", "yrbgcsy", "rrpppss", "yrbpcsy", "rrpppss", "yrbgcsy", "ttttttt"],
    regionTypes: { y: "yellow", g: "green", b: "blue", c: "blue", p: "purple", r: "red", s: "red", o: "orangeHigh", t: "orangeLow" },
    regionNames: { y: "amarilla", g: "verde1", b: "azul1", c: "azul2", p: "morada1", r: "roja1", s: "roja2", o: "naranjaSuperior", t: "naranjaInferior" },
    points: { y: [8, 6, 4], g: [3, 2, 1], b: [8, 6, 4], c: [8, 6, 4], p: [7, 5, 3], r: [6, 4, 2], s: [6, 4, 2], o: [6, 4, 3], t: [6, 4, 3] },
    initial: [{ row: 0, column: 4 }, { row: 2, column: 2 }, { row: 2, column: 5 }, { row: 3, column: 0 }, { row: 5, column: 4 }, { row: 6, column: 1 }],
  },
};

const scoreThresholds: Record<number, number> = {
  2: 26,
  3: 24,
  4: 22,
  5: 20,
  6: 18,
};

export function scoreToWin(playerCount: number): number {
  const threshold = scoreThresholds[playerCount];
  if (threshold === undefined) {
    throw new MultiplayerError("INVALID_PLAYER_COUNT", "La sala necesita entre 2 y 6 jugadores.", 400);
  }
  return threshold;
}

export class MultiplayerError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode = 400,
  ) {
    super(message);
    this.name = "MultiplayerError";
  }
}

export function pointsForRegion(
  mapId: number,
  region: string,
  position: number,
): number {
  const rules = MAPS[mapId];
  if (!rules) {
    throw new MultiplayerError("INVALID_MAP", "Selecciona un mapa válido.", 400);
  }
  if (!Number.isInteger(position) || position < 1) {
    throw new MultiplayerError(
      "INVALID_SCORE_POSITION",
      "La posición de puntuación debe ser un entero positivo.",
      400,
    );
  }
  return rules.points[region]?.[position - 1] ?? 0;
}

export class MultiplayerService {
  private readonly rooms = new Map<string, Room>();
  private readonly roomByPlayer = new Map<string, string>();
  private readonly knownPlayers = new Map<string, { name: string; lastSeenAt: number }>();
  private readonly closedRooms = new Map<string, ClosedRoom>();
  private readonly joinAttempts = new Map<string, number[]>();
  private readonly createAttempts = new Map<string, number[]>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly randomValue: (max: number) => number = randomInt,
  ) {}

  listLobby(user: MultiplayerUser): LobbySnapshot {
    this.sweep();
    this.touchUser(user);
    return {
      activePlayers: [...this.knownPlayers.entries()]
        .filter(([, player]) => this.now() - player.lastSeenAt <= PRESENCE_STALE_MS)
        .map(([id, player]) => ({ id, name: player.name }))
        .sort((left, right) => left.name.localeCompare(right.name)),
      rooms: [...this.rooms.values()]
        .filter((room) => room.phase === "waiting")
        .map((room) => ({
          code: room.code,
          mapId: room.mapId,
          hostName: room.players.find((player) => player.id === room.hostId)?.name ?? "Anfitrión",
          playerCount: room.players.filter((player) => !player.forfeited).length,
          connectedPlayerCount: room.players.filter((player) => this.isConnected(player)).length,
        }))
        .sort((left, right) => left.code.localeCompare(right.code)),
    };
  }

  createRoom(user: MultiplayerUser, mapId: number): RoomSnapshot {
    this.sweep();
    this.touchUser(user);
    this.ensureNotInRoom(user.id);
    if (!MAPS[mapId]) {
      throw new MultiplayerError("INVALID_MAP", "Selecciona un mapa válido.", 400);
    }
    const recentCreations = (this.createAttempts.get(user.id) ?? []).filter(
      (time) => this.now() - time < 60_000,
    );
    if (recentCreations.length >= 3) {
      this.createAttempts.set(user.id, recentCreations);
      throw new MultiplayerError(
        "CREATE_RATE_LIMITED",
        "Creaste varias salas. Espera un minuto antes de crear otra.",
        429,
      );
    }
    recentCreations.push(this.now());
    this.createAttempts.set(user.id, recentCreations);

    const code = this.createCode();
    const room: Room = {
      code,
      mapId,
      hostId: user.id,
      phase: "waiting",
      players: [this.newPlayer(user, true)],
      playerCountAtStart: 0,
      dice: null,
      round: 0,
      revision: 1,
      regionCounters: {},
      regionLastClaimRound: {},
      winners: [],
      finishReason: null,
      events: [],
      createdAt: this.now(),
      finishedAt: null,
    };
    this.rooms.set(code, room);
    this.roomByPlayer.set(user.id, code);
    this.addEvent(room, `${user.name} creó la sala.`);
    return this.snapshot(room, user.id);
  }

  joinRoom(user: MultiplayerUser, suppliedCode: string): RoomSnapshot {
    this.sweep();
    this.touchUser(user);
    this.ensureNotInRoom(user.id);
    const attempts = (this.joinAttempts.get(user.id) ?? []).filter((time) => this.now() - time < 60_000);
    if (attempts.length >= 10) {
      this.joinAttempts.set(user.id, attempts);
      throw new MultiplayerError("JOIN_RATE_LIMITED", "Demasiados intentos. Espera un minuto.", 429);
    }
    attempts.push(this.now());
    this.joinAttempts.set(user.id, attempts);

    const code = suppliedCode.trim().toUpperCase();
    const room = this.rooms.get(code);
    if (!room || room.phase !== "waiting") {
      throw new MultiplayerError("ROOM_NOT_FOUND", "La sala no existe o ya comenzó.", 404);
    }
    if (room.players.filter((player) => !player.forfeited).length >= 6) {
      throw new MultiplayerError("ROOM_FULL", "La sala ya tiene 6 jugadores.", 409);
    }
    room.players.push(this.newPlayer(user, false));
    this.roomByPlayer.set(user.id, code);
    room.revision++;
    this.addEvent(room, `${user.name} se unió a la sala.`);
    return this.snapshot(room, user.id);
  }

  getRoom(user: MultiplayerUser, suppliedCode: string): RoomSnapshot {
    this.sweep();
    this.touchUser(user);
    const code = suppliedCode.trim().toUpperCase();
    const room = this.rooms.get(code);
    if (!room) {
      const closed = this.closedRooms.get(code);
      if (closed && closed.expiresAt > this.now()) {
        throw new MultiplayerError("ROOM_DISSOLVED", closed.message, 410);
      }
      throw new MultiplayerError("ROOM_NOT_FOUND", "La sala ya no está disponible.", 404);
    }
    const player = this.requireMember(room, user.id);
    player.lastSeenAt = this.now();
    return this.snapshot(room, user.id);
  }

  startRoom(user: MultiplayerUser, suppliedCode: string): RoomSnapshot {
    this.sweep();
    const room = this.requireRoom(suppliedCode);
    this.touchRoomMember(room, user);
    if (room.hostId !== user.id) {
      throw new MultiplayerError("HOST_ONLY", "Solo el anfitrión puede iniciar la partida.", 403);
    }
    if (room.phase !== "waiting") {
      throw new MultiplayerError("ROOM_ALREADY_STARTED", "La partida ya comenzó.", 409);
    }
    const players = room.players.filter((player) => !player.forfeited);
    if (players.length < 2) {
      throw new MultiplayerError("NOT_ENOUGH_PLAYERS", "Se necesitan al menos 2 jugadores.", 409);
    }
    if (players.some((player) => !this.isConnected(player))) {
      throw new MultiplayerError(
        "PLAYER_RECONNECTING",
        "Espera a que todos los jugadores vuelvan a conectarse.",
        409,
      );
    }
    room.phase = "setup";
    room.playerCountAtStart = players.length;
    room.revision++;
    this.addEvent(room, `${user.name} inició la partida.`);
    return this.snapshot(room, user.id);
  }

  submitInitialBoard(
    user: MultiplayerUser,
    suppliedCode: string,
    values: number[],
  ): RoomSnapshot {
    this.sweep();
    const room = this.requireRoom(suppliedCode);
    this.touchRoomMember(room, user);
    if (room.phase !== "setup") {
      throw new MultiplayerError("GAME_NOT_IN_SETUP", "La configuración inicial ya terminó.", 409);
    }
    const player = this.requireMember(room, user.id);
    if (
      values.length !== 6 ||
      new Set(values).size !== 6 ||
      values.some((value) => !Number.isInteger(value) || value < 1 || value > 6)
    ) {
      throw new MultiplayerError("INVALID_INITIAL_BOARD", "Coloca los números del 1 al 6 sin repetir.", 400);
    }
    const board = EMPTY_BOARD();
    const candidate = { ...player, board };
    const rules = MAPS[room.mapId];
    for (let index = 0; index < rules.initial.length; index++) {
      const position = rules.initial[index];
      if (!this.canPlace(room, candidate, position, values[index])) {
        throw new MultiplayerError(
          "INVALID_INITIAL_BOARD",
          "Los números iniciales no cumplen las reglas del mapa.",
          400,
        );
      }
      board[position.row][position.column] = values[index];
    }
    player.board = board;
    player.ready = true;
    room.revision++;
    this.addEvent(room, `${player.name} configuró su tablero.`);

    if (room.players.filter((entry) => !entry.forfeited).every((entry) => entry.ready)) {
      room.phase = "playing";
      this.startNextRound(room);
    }
    return this.snapshot(room, user.id);
  }

  playMove(
    user: MultiplayerUser,
    suppliedCode: string,
    input: {
      round: number;
      anchorDieIndex: number;
      anchor: Position;
      destination: Position;
      commandId: string;
    },
  ): RoomSnapshot {
    this.sweep();
    const room = this.requireRoom(suppliedCode);
    this.touchRoomMember(room, user);
    if (
      typeof input.commandId === "string" &&
      input.commandId.length >= 16 &&
      room.events.some((event) => event.id === input.commandId)
    ) {
      return this.snapshot(room, user.id);
    }
    if (room.phase !== "playing") {
      throw new MultiplayerError("GAME_NOT_ACTIVE", "La partida no está activa.", 409);
    }
    if (this.roomByPlayer.get(user.id) !== room.code) {
      throw new MultiplayerError("PLAYER_FORFEITED", "Ya abandonaste esta partida.", 403);
    }
    if (input.round !== room.round) {
      throw new MultiplayerError(
        "STALE_ROUND",
        "La ronda cambió. Se actualizaron los dados de la sala.",
        409,
      );
    }
    if (!Number.isInteger(input.anchorDieIndex) || input.anchorDieIndex < 0 || input.anchorDieIndex > 1) {
      throw new MultiplayerError("INVALID_MOVE", "Selecciona uno de los dados.", 400);
    }

    const anchor = this.position(input.anchor);
    const destination = this.position(input.destination);
    const player = this.requireMember(room, user.id);
    if (player.playedThisRound) {
      throw new MultiplayerError(
        "ROUND_ALREADY_COMPLETED",
        "Ya completaste tu jugada de esta ronda.",
        409,
      );
    }
    const anchorValue = room.dice![input.anchorDieIndex];
    const destinationValue = room.dice![1 - input.anchorDieIndex];
    if (
      player.board[anchor.row][anchor.column] !== anchorValue ||
      Math.abs(anchor.row - destination.row) + Math.abs(anchor.column - destination.column) !== 1 ||
      player.board[destination.row][destination.column] !== null ||
      !this.canPlace(room, player, destination, destinationValue)
    ) {
      throw new MultiplayerError("INVALID_MOVE", "Esa jugada no es válida para los dados y el tablero actuales.", 400);
    }

    player.board[destination.row][destination.column] = destinationValue;
    player.playedThisRound = true;
    let pointsEarned = 0;
    for (let row = 0; row < 7; row++) {
      for (let column = 0; column < 7; column++) {
        const region = MAPS[room.mapId].rows[row][column];
        if (player.completedRegions.has(region)) continue;
        const isComplete = MAPS[room.mapId].rows.every((mapRow, regionRow) =>
          [...mapRow].every((cell, regionColumn) =>
            cell !== region || player.board[regionRow][regionColumn] !== null,
          ),
        );
        if (isComplete) {
          player.completedRegions.add(region);
          const regionName = MAPS[room.mapId].regionNames[region];
          let position = room.regionCounters[regionName] ?? 0;
          const sharedThisRound =
            room.regionLastClaimRound[regionName] === room.round;
          if (!sharedThisRound) {
            position++;
            room.regionCounters[regionName] = position;
            room.regionLastClaimRound[regionName] = room.round;
          }
          const points = pointsForRegion(room.mapId, region, position);
          player.score += points;
          pointsEarned += points;
          this.addEvent(
            room,
            `${user.name} completó ${regionName}: recompensa ${position}${sharedThisRound ? " compartida en esta ronda" : ""} (${points} puntos).`,
          );
        }
      }
    }
    room.revision++;
    this.addEvent(
      room,
      `${user.name} colocó un ${destinationValue}${pointsEarned > 0 ? ` y obtuvo ${pointsEarned} puntos` : ""}.`,
      input.commandId,
    );

    this.advanceRoundWhenComplete(room);
    return this.snapshot(room, user.id);
  }

  skipRound(
    user: MultiplayerUser,
    suppliedCode: string,
    round: number,
  ): RoomSnapshot {
    this.sweep();
    const room = this.requireRoom(suppliedCode);
    this.touchRoomMember(room, user);
    if (room.phase !== "playing") {
      throw new MultiplayerError("GAME_NOT_ACTIVE", "La partida no está activa.", 409);
    }
    if (this.roomByPlayer.get(user.id) !== room.code) {
      throw new MultiplayerError("PLAYER_FORFEITED", "Ya abandonaste esta partida.", 403);
    }
    if (round !== room.round) {
      throw new MultiplayerError(
        "STALE_ROUND",
        "La ronda cambió. Se actualizaron los dados de la sala.",
        409,
      );
    }
    const player = this.requireMember(room, user.id);
    if (player.playedThisRound) {
      throw new MultiplayerError(
        "ROUND_ALREADY_COMPLETED",
        "Ya completaste tu jugada de esta ronda.",
        409,
      );
    }
    player.playedThisRound = true;
    this.addEvent(room, `${user.name} terminó su ronda sin colocar un número.`);
    room.revision++;
    this.advanceRoundWhenComplete(room);
    return this.snapshot(room, user.id);
  }

  leaveRoom(user: MultiplayerUser, suppliedCode: string): { dissolved: boolean; message?: string; room?: RoomSnapshot } {
    const code = suppliedCode.trim().toUpperCase();
    const room = this.rooms.get(code);
    if (!room) {
      const closed = this.closedRooms.get(code);
      if (closed) return { dissolved: true, message: closed.message };
      throw new MultiplayerError("ROOM_NOT_FOUND", "La sala ya no está disponible.", 404);
    }
    const player = this.requireMember(room, user.id);
    if ((room.phase === "waiting" || room.phase === "setup") && player.isHost) {
      const message = "El anfitrión abandonó la sala antes de iniciar la partida.";
      this.closeRoom(room, message);
      return { dissolved: true, message };
    }
    if (room.phase === "waiting" || room.phase === "setup") {
      this.removePlayer(room, player);
      this.addEvent(room, `${player.name} abandonó la sala.`);
      if (room.phase === "setup" && room.players.filter((entry) => !entry.forfeited).length < 2) {
        const message = "La sala se cerró porque ya no hay suficientes jugadores.";
        this.closeRoom(room, message);
        return { dissolved: true, message };
      }
      return { dissolved: false, message: "Saliste de la sala." };
    }
    if (room.phase === "playing") {
      this.forfeit(room, player, player.isHost ? "host_forfeit" : "player_forfeit");
      return { dissolved: false, room: this.snapshot(room, user.id) };
    }
    this.roomByPlayer.delete(player.id);
    player.forfeited = true;
    return { dissolved: false, room: this.snapshot(room, user.id) };
  }

  sweep(at = this.now()): void {
    for (const [code, room] of this.rooms) {
      if (room.phase === "finished" && room.finishedAt !== null && at - room.finishedAt > ROOM_RETENTION_MS) {
        this.closeRoom(room, "La sala finalizó.");
        continue;
      }
      const disconnected = room.players.filter(
        (player) =>
          !player.forfeited &&
          at - player.lastSeenAt >= DISCONNECT_GRACE_MS,
      );
      if (room.phase === "waiting") {
        if (disconnected.some((player) => player.isHost)) {
          this.closeRoom(room, "El anfitrión se desconectó y la sala fue cerrada.");
          continue;
        }
        for (const player of disconnected) this.removePlayer(room, player);
      } else if (room.phase === "playing" && disconnected.length > 0) {
        for (const player of disconnected) {
          this.forfeit(room, player, "player_disconnected");
        }
        this.advanceRoundWhenComplete(room);
      } else if (room.phase === "setup" && disconnected.length > 0) {
        if (disconnected.some((player) => player.isHost)) {
          this.closeRoom(room, "El anfitrión se desconectó y la sala fue cerrada.");
          continue;
        }
        for (const player of disconnected) {
          player.forfeited = true;
          this.roomByPlayer.delete(player.id);
          room.revision++;
          this.addEvent(
            room,
            `${player.name} no se reconectó en 60 segundos y salió de la sala.`,
          );
        }
        const remaining = room.players.filter((player) => !player.forfeited);
        if (remaining.length < 2) {
          this.closeRoom(
            room,
            "La sala se cerró porque ya no hay suficientes jugadores.",
          );
        } else if (remaining.every((player) => player.ready)) {
          room.phase = "playing";
          this.startNextRound(room);
        }
      }
    }
    for (const [code, room] of this.closedRooms) {
      if (room.expiresAt <= at) this.closedRooms.delete(code);
    }
    for (const [id, player] of this.knownPlayers) {
      if (at - player.lastSeenAt >= DISCONNECT_GRACE_MS) this.knownPlayers.delete(id);
    }
    for (const [id, attempts] of this.joinAttempts) {
      const recent = attempts.filter((time) => at - time < 60_000);
      if (recent.length === 0) this.joinAttempts.delete(id);
      else this.joinAttempts.set(id, recent);
    }
    for (const [id, attempts] of this.createAttempts) {
      const recent = attempts.filter((time) => at - time < 60_000);
      if (recent.length === 0) this.createAttempts.delete(id);
      else this.createAttempts.set(id, recent);
    }
  }

  private startNextRound(room: Room): void {
    if (room.phase !== "playing") return;
    const players = room.players.filter((player) => !player.forfeited);
    if (players.length === 0) {
      this.finish(room, players.map((player) => player.id), "forfeit");
      return;
    }
    room.round++;
    room.dice = [this.rollDie(), this.rollDie()];
    room.revision++;
    let playersWithMoves = 0;
    for (const player of players) {
      player.playedThisRound = !this.hasLegalMove(room, player);
      if (player.playedThisRound) {
        this.addEvent(
          room,
          `${player.name} no tiene jugadas válidas con estos dados; terminó su ronda automáticamente.`,
        );
      } else {
        playersWithMoves++;
      }
    }
    if (playersWithMoves > 0) return;
    const highScore = Math.max(...players.map((player) => player.score));
    const winners = players.filter((player) => player.score === highScore).map((player) => player.id);
    this.finish(room, winners, "no_moves");
  }

  private allPlayersCompletedRound(room: Room): boolean {
    const players = room.players.filter((player) => !player.forfeited);
    return players.length > 0 && players.every((player) => player.playedThisRound);
  }

  private advanceRoundWhenComplete(room: Room): void {
    const players = room.players.filter((player) => !player.forfeited);
    if (players.length === 0) {
      this.finish(room, [], "forfeit");
      return;
    }
    if (!this.allPlayersCompletedRound(room)) return;
    const winners = room.players.filter(
      (player) =>
        !player.forfeited &&
        player.score >= scoreToWin(room.playerCountAtStart),
    );
    if (winners.length > 0) {
      this.finish(room, winners.map((player) => player.id), "score");
      return;
    }
    this.startNextRound(room);
  }

  private hasLegalMove(room: Room, player: Player): boolean {
    const dice = room.dice!;
    for (let row = 0; row < 7; row++) {
      for (let column = 0; column < 7; column++) {
        for (const anchorDieIndex of [0, 1]) {
          if (player.board[row][column] !== dice[anchorDieIndex]) continue;
          const neighbors = [
            { row: row - 1, column },
            { row: row + 1, column },
            { row, column: column - 1 },
            { row, column: column + 1 },
          ];
          if (neighbors.some((position) =>
            this.isInBounds(position) &&
            player.board[position.row][position.column] === null &&
            this.canPlace(room, player, position, dice[1 - anchorDieIndex]),
          )) {
            return true;
          }
        }
      }
    }
    return false;
  }

  private canPlace(room: Room, player: Player, position: Position, value: number): boolean {
    const region = MAPS[room.mapId].rows[position.row][position.column];
    const regionType = MAPS[room.mapId].regionTypes[region];
    const currentValues: number[] = [];
    for (let row = 0; row < 7; row++) {
      for (let column = 0; column < 7; column++) {
        if (MAPS[room.mapId].rows[row][column] === region && player.board[row][column] !== null) {
          currentValues.push(player.board[row][column]!);
        }
      }
    }
    if (regionType === "green") return true;
    if (regionType === "blue" || regionType === "white") {
      return currentValues.length === 0 || currentValues.every((current) => current === value);
    }
    if (regionType === "yellow" || regionType === "red") {
      return !currentValues.includes(value);
    }
    if (regionType === "orangeHigh") return value >= 4 && value <= 6;
    if (regionType === "orangeLow") return value >= 1 && value <= 3;
    if (regionType === "purple") {
      const distinct = new Set([...currentValues, value]);
      if (distinct.size > 2) return false;
      const regionSize = MAPS[room.mapId].rows.reduce(
        (sum, row) => sum + [...row].filter((cell) => cell === region).length,
        0,
      );
      return currentValues.length !== regionSize - 1 || distinct.size > 1;
    }
    return false;
  }

  private finish(room: Room, winners: string[], reason: string): void {
    room.phase = "finished";
    room.finishedAt = this.now();
    room.dice = null;
    room.winners = winners;
    room.finishReason = reason;
    room.revision++;
    const names = room.players.filter((player) => winners.includes(player.id)).map((player) => player.name);
    this.addEvent(room, names.length > 0 ? `Partida finalizada. Ganador(es): ${names.join(", ")}.` : "La partida finalizó sin ganador.");
    for (const player of room.players) this.roomByPlayer.delete(player.id);
  }

  private forfeit(room: Room, player: Player, reason: string): void {
    if (room.phase !== "playing" || player.forfeited) return;
    player.forfeited = true;
    this.roomByPlayer.delete(player.id);
    room.revision++;
    this.addEvent(
      room,
      reason.includes("disconnect")
        ? `${player.name} se desconectó y abandonó la partida.`
        : `${player.name} abandonó la partida.`,
    );
  }

  private removePlayer(room: Room, player: Player): void {
    room.players = room.players.filter((entry) => entry.id !== player.id);
    this.roomByPlayer.delete(player.id);
    room.revision++;
  }

  private closeRoom(room: Room, message: string): void {
    this.addEvent(room, message);
    for (const player of room.players) this.roomByPlayer.delete(player.id);
    this.rooms.delete(room.code);
    this.closedRooms.set(room.code, { message, expiresAt: this.now() + ROOM_RETENTION_MS });
  }

  private createCode(): string {
    for (let attempt = 0; attempt < 20; attempt++) {
      let code = "";
      for (let index = 0; index < 6; index++) {
        code += CODE_ALPHABET[this.randomValue(CODE_ALPHABET.length)];
      }
      if (!this.rooms.has(code) && !this.closedRooms.has(code)) return code;
    }
    throw new MultiplayerError("ROOM_CREATION_FAILED", "No se pudo crear el código de sala. Inténtalo otra vez.", 503);
  }

  private rollDie(): number {
    return this.randomValue(6) + 1;
  }

  private newPlayer(user: MultiplayerUser, isHost: boolean): Player {
    return {
      id: user.id,
      name: user.name,
      isHost,
      lastSeenAt: this.now(),
      board: EMPTY_BOARD(),
      ready: false,
      score: 0,
      forfeited: false,
      completedRegions: new Set<string>(),
      playedThisRound: false,
    };
  }

  private touchUser(user: MultiplayerUser): void {
    this.knownPlayers.set(user.id, { name: user.name, lastSeenAt: this.now() });
  }

  private touchRoomMember(room: Room, user: MultiplayerUser): void {
    this.touchUser(user);
    this.requireMember(room, user.id).lastSeenAt = this.now();
  }

  private ensureNotInRoom(userId: string): void {
    const code = this.roomByPlayer.get(userId);
    if (code && this.rooms.has(code)) {
      throw new MultiplayerError("ALREADY_IN_ROOM", "Abandona tu sala actual antes de entrar a otra.", 409);
    }
    this.roomByPlayer.delete(userId);
  }

  private requireRoom(suppliedCode: string): Room {
    const room = this.rooms.get(suppliedCode.trim().toUpperCase());
    if (!room) throw new MultiplayerError("ROOM_NOT_FOUND", "La sala ya no está disponible.", 404);
    return room;
  }

  private requireMember(room: Room, playerId: string): Player {
    const player = room.players.find((entry) => entry.id === playerId);
    if (!player) {
      throw new MultiplayerError(
        "ROOM_NOT_FOUND",
        "La sala no existe o ya no está disponible.",
        404,
      );
    }
    return player;
  }

  private position(position: Position): Position {
    if (!position || !Number.isInteger(position.row) || !Number.isInteger(position.column) ||
      position.row < 0 || position.row >= 7 || position.column < 0 || position.column >= 7) {
      throw new MultiplayerError("INVALID_MOVE", "Las coordenadas no son válidas.", 400);
    }
    return position;
  }

  private isInBounds(position: Position): boolean {
    return position.row >= 0 && position.row < 7 && position.column >= 0 && position.column < 7;
  }

  private isConnected(player: Player): boolean {
    return !player.forfeited && this.now() - player.lastSeenAt <= PRESENCE_STALE_MS;
  }

  private addEvent(room: Room, message: string, id: string = randomUUID()): void {
    room.events.push({ id, message, createdAt: new Date(this.now()).toISOString() });
    if (room.events.length > 30) room.events.splice(0, room.events.length - 30);
  }

  private snapshot(room: Room, playerId: string): RoomSnapshot {
    const remaining = room.players.filter((player) => !player.forfeited).length;
    const player = this.requireMember(room, playerId);
    return {
      code: room.code,
      mapId: room.mapId,
      phase: room.phase,
      hostId: room.hostId,
      players: room.players.map((player) => ({
        id: player.id,
        name: player.name,
        isHost: player.isHost,
        connected: this.isConnected(player),
        score: player.score,
        forfeited: player.forfeited,
        isWinner: room.winners.includes(player.id),
        ready: player.ready,
        playedThisRound: player.playedThisRound,
      })),
      board: player.board.map((row) => [...row]),
      dice: room.dice ? [...room.dice] as [number, number] : null,
      round: room.round,
      scoreToWin: room.phase === "waiting" ? 0 : scoreToWin(room.playerCountAtStart || Math.max(2, remaining)),
      revision: room.revision,
      winners: [...room.winners],
      finishReason: room.finishReason,
      events: room.events.map((event) => ({ ...event })),
      regionCounters: { ...room.regionCounters },
    };
  }
}
