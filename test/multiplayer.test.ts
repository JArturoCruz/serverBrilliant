import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MultiplayerError,
  MultiplayerService,
  pointsForRegion,
  scoreToWin,
  type MultiplayerUser,
  type RoomSnapshot,
} from "../multiplayer.js";

const users: MultiplayerUser[] = Array.from({ length: 7 }, (_, index) => ({
  id: `player-${index + 1}`,
  name: `Jugador ${index + 1}`,
}));
let commandSequence = 0;

function createService(now: () => number = Date.now): MultiplayerService {
  let value = 0;
  return new MultiplayerService(now, (max) => value++ % max);
}

function startAndConfigure(
  service: MultiplayerService,
  host: MultiplayerUser,
  code: string,
  players: MultiplayerUser[],
  mapId: number,
): RoomSnapshot {
  service.startRoom(host, code);
  const values = mapId === 4 ? [4, 1, 2, 6, 5, 3] : [1, 2, 3, 4, 5, 6];
  let room: RoomSnapshot | undefined;
  for (const player of players) {
    room = service.submitInitialBoard(player, code, values);
  }
  assert.ok(room);
  return room;
}

function expectCode(action: () => unknown, code: string): void {
  assert.throws(action, (error: unknown) =>
    error instanceof MultiplayerError && error.code === code,
  );
}

function makeFirstValidMove(
  service: MultiplayerService,
  user: MultiplayerUser,
  room: RoomSnapshot,
): RoomSnapshot {
  assert.ok(room.dice);
  const indexes = [0, 1];
  for (const anchorDieIndex of indexes) {
    const anchorValue = room.dice[anchorDieIndex];
    for (let row = 0; row < 7; row++) {
      for (let column = 0; column < 7; column++) {
        if (room.board[row][column] !== anchorValue) continue;
        const destinations = [
          { row: row - 1, column },
          { row: row + 1, column },
          { row, column: column - 1 },
          { row, column: column + 1 },
        ];
        for (const destination of destinations) {
          if (
            destination.row < 0 ||
            destination.row >= 7 ||
            destination.column < 0 ||
            destination.column >= 7 ||
            room.board[destination.row][destination.column] !== null
          ) {
            continue;
          }
          try {
            return service.playMove(user, room.code, {
              round: room.round,
              anchorDieIndex,
              anchor: { row, column },
              destination,
              commandId: `00000000-0000-4000-8000-${String(++commandSequence).padStart(12, "0")}`,
            });
          } catch (error) {
            if (!(error instanceof MultiplayerError) || error.code !== "INVALID_MOVE") {
              throw error;
            }
          }
        }
      }
    }
  }
  assert.fail("El servidor entregó dados sin una jugada legal.");
}

const map4BluePath: Array<{
  anchor: { row: number; column: number };
  destination: { row: number; column: number };
}> = [
  { anchor: { row: 2, column: 2 }, destination: { row: 1, column: 2 } },
  { anchor: { row: 2, column: 2 }, destination: { row: 3, column: 2 } },
  { anchor: { row: 3, column: 2 }, destination: { row: 4, column: 2 } },
  { anchor: { row: 4, column: 2 }, destination: { row: 5, column: 2 } },
];

function createMap4ScoringRoom(
  players: MultiplayerUser[],
): { service: MultiplayerService; code: string } {
  const service = new MultiplayerService(
    Date.now,
    (max) => (max === 6 ? 0 : 0),
  );
  const waiting = service.createRoom(players[0], 4);
  for (const player of players.slice(1)) service.joinRoom(player, waiting.code);
  startAndConfigure(service, players[0], waiting.code, players, 4);
  return { service, code: waiting.code };
}

function performMap4RoundAction(
  service: MultiplayerService,
  user: MultiplayerUser,
  code: string,
  move: (typeof map4BluePath)[number] | null,
): RoomSnapshot {
  const room = service.getRoom(user, code);
  if (move === null) return service.skipRound(user, code, room.round);
  return service.playMove(user, code, {
    round: room.round,
    anchorDieIndex: 0,
    anchor: move.anchor,
    destination: move.destination,
    commandId: `00000000-0000-4000-8000-${String(++commandSequence).padStart(12, "0")}`,
  });
}

test("uses the requested score thresholds for rooms of two through six players", () => {
  assert.deepEqual([2, 3, 4, 5, 6].map(scoreToWin), [26, 24, 22, 20, 18]);
  expectCode(() => scoreToWin(1), "INVALID_PLAYER_COUNT");
  expectCode(() => scoreToWin(7), "INVALID_PLAYER_COUNT");
});

test("keeps multiplayer region scoring aligned with all four board maps", () => {
  const scoreTables: Record<number, Record<string, number[]>> = {
    1: {
      y: [8, 6, 4],
      g: [4, 3, 2],
      b: [7, 5, 3],
      p: [6, 4, 2],
      r: [6, 4, 2],
    },
    2: {
      y: [6, 4, 2],
      g: [4, 3, 2],
      b: [7, 5, 3],
      p: [6, 4, 2],
      r: [6, 4, 2],
      w: [3, 2, 1],
    },
    3: {
      y: [7, 5, 3],
      g: [6, 5, 4],
      b: [7, 5, 3],
      p: [7, 5, 3],
      r: [6, 4, 2],
      w: [8, 6, 4],
    },
    4: {
      y: [8, 6, 4],
      g: [3, 2, 1],
      b: [8, 6, 4],
      p: [7, 5, 3],
      r: [6, 4, 2],
      o: [6, 4, 3],
      t: [6, 4, 3],
    },
  };

  for (const [mapId, regions] of Object.entries(scoreTables)) {
    for (const [region, scores] of Object.entries(regions)) {
      for (const [index, points] of scores.entries()) {
        assert.equal(pointsForRegion(Number(mapId), region, index + 1), points);
      }
    }
  }
  assert.equal(pointsForRegion(1, "unscored", 1), 0);
  expectCode(() => pointsForRegion(5, "y", 1), "INVALID_MAP");
  expectCode(() => pointsForRegion(1, "y", 0), "INVALID_SCORE_POSITION");
});

test("shares the first region reward among players who complete it in the same round", () => {
  const players = users.slice(0, 4);
  const { service, code } = createMap4ScoringRoom(players);

  for (const move of map4BluePath) {
    for (const player of players) {
      performMap4RoundAction(service, player, code, move);
    }
  }

  const room = service.getRoom(players[0], code);
  assert.equal(room.round, 5);
  assert.equal(room.regionCounters.azul1, 1);
  assert.deepEqual(
    room.players.map((player) => player.score),
    [8, 8, 8, 8],
  );
  assert.ok(room.players.every((player) => !player.playedThisRound));
});

test("keeps the second region reward available for the next completion round", () => {
  const players = users.slice(0, 3);
  const { service, code } = createMap4ScoringRoom(players);

  for (const move of map4BluePath.slice(0, 3)) {
    performMap4RoundAction(service, players[0], code, move);
    performMap4RoundAction(service, players[1], code, move);
    performMap4RoundAction(service, players[2], code, null);
  }
  performMap4RoundAction(service, players[0], code, map4BluePath[3]);
  performMap4RoundAction(service, players[1], code, map4BluePath[3]);
  performMap4RoundAction(service, players[2], code, map4BluePath[0]);

  assert.equal(service.getRoom(players[0], code).regionCounters.azul1, 1);
  assert.deepEqual(
    service.getRoom(players[0], code).players.map((player) => player.score),
    [8, 8, 0],
  );

  for (const move of map4BluePath.slice(1)) {
    performMap4RoundAction(service, players[0], code, null);
    performMap4RoundAction(service, players[1], code, null);
    performMap4RoundAction(service, players[2], code, move);
  }

  const room = service.getRoom(players[0], code);
  assert.equal(room.regionCounters.azul1, 2);
  assert.deepEqual(
    room.players.map((player) => player.score),
    [8, 8, 6],
  );
});

test("keeps an abandoned player's completed-zone reward permanently claimed", () => {
  const players = users.slice(0, 2);
  const { service, code } = createMap4ScoringRoom(players);

  for (const move of map4BluePath) {
    performMap4RoundAction(service, players[0], code, move);
    performMap4RoundAction(service, players[1], code, null);
  }

  const beforeLeaving = service.getRoom(players[0], code);
  assert.equal(beforeLeaving.regionCounters.azul1, 1);
  assert.equal(
    beforeLeaving.players.find((player) => player.id === players[0].id)?.score,
    8,
  );

  const result = service.leaveRoom(players[0], code);
  assert.equal(result.room?.phase, "playing");
  assert.equal(result.room?.regionCounters.azul1, 1);
  assert.equal(
    result.room?.players.find((player) => player.id === players[0].id)?.forfeited,
    true,
  );
  assert.equal(
    result.room?.players.find((player) => player.id === players[1].id)?.score,
    0,
  );

  for (const move of map4BluePath) {
    performMap4RoundAction(service, players[1], code, move);
  }
  const afterCompletion = service.getRoom(players[1], code);
  assert.equal(afterCompletion.phase, "playing");
  assert.equal(afterCompletion.regionCounters.azul1, 2);
  assert.equal(
    afterCompletion.players.find((player) => player.id === players[0].id)?.score,
    8,
  );
  assert.equal(
    afterCompletion.players.find((player) => player.id === players[1].id)?.score,
    6,
  );
});

test("creates private invite codes and enforces host, capacity, and membership rules", () => {
  const service = createService();
  const room = service.createRoom(users[0], 1);
  assert.match(room.code, /^[A-HJ-NP-Z2-9]{6}$/);
  expectCode(() => service.startRoom(users[0], room.code), "NOT_ENOUGH_PLAYERS");
  expectCode(() => service.joinRoom(users[0], room.code), "ALREADY_IN_ROOM");
  expectCode(() => service.startRoom(users[1], room.code), "ROOM_NOT_FOUND");

  for (const user of users.slice(1, 6)) service.joinRoom(user, room.code);
  expectCode(() => service.joinRoom(users[6], room.code), "ROOM_FULL");
  assert.equal(service.getRoom(users[0], room.code).players.length, 6);
});

test("only the host starts and all four maps receive valid starting values", () => {
  for (const mapId of [1, 2, 3, 4]) {
    const service = createService();
    const host = users[mapId - 1];
    const guest = users[mapId];
    const waiting = service.createRoom(host, mapId);
    service.joinRoom(guest, waiting.code);
    if (mapId === 4) {
      expectCode(() => service.startRoom(guest, waiting.code), "HOST_ONLY");
    }

    const room = startAndConfigure(service, host, waiting.code, [host, guest], mapId);
    assert.equal(room.phase, "playing");
    assert.equal(room.scoreToWin, 26);
    const startingValues = room.board.flat().filter((value) => value !== null);
    assert.equal(startingValues.length, 6);
    assert.deepEqual([...startingValues].sort(), [1, 2, 3, 4, 5, 6]);
    assert.ok(room.dice?.every((die) => die >= 1 && die <= 6));
    if (mapId === 4) {
      assert.ok(room.board[0][4]! >= 4);
      assert.ok(room.board[6][1]! <= 3);
    }
  }
});

test("validates map-specific starting-cell rules without partially saving an invalid board", () => {
  const service = createService();
  const waiting = service.createRoom(users[0], 4);
  service.joinRoom(users[1], waiting.code);
  service.startRoom(users[0], waiting.code);

  expectCode(
    () => service.submitInitialBoard(users[0], waiting.code, [3, 1, 2, 5, 4, 6]),
    "INVALID_INITIAL_BOARD",
  );
  expectCode(
    () => service.submitInitialBoard(users[0], waiting.code, [4, 1, 2, 5, 3, 6]),
    "INVALID_INITIAL_BOARD",
  );
  const unchanged = service.getRoom(users[0], waiting.code);
  assert.equal(unchanged.players[0].ready, false);
  assert.ok(unchanged.board.flat().every((value) => value === null));

  service.submitInitialBoard(users[0], waiting.code, [4, 1, 2, 6, 5, 3]);
  const configured = service.submitInitialBoard(
    users[1],
    waiting.code,
    [4, 1, 2, 6, 5, 3],
  );
  assert.equal(configured.phase, "playing");
});

test("keeps player boards separate and advances shared dice after every player completes the round", () => {
  let dieValue = 0;
  const service = new MultiplayerService(
    () => 0,
    (max) => (max === 6 ? dieValue++ % max : 0),
  );
  const waiting = service.createRoom(users[0], 1);
  service.joinRoom(users[1], waiting.code);
  service.startRoom(users[0], waiting.code);
  service.submitInitialBoard(users[0], waiting.code, [1, 2, 3, 4, 5, 6]);
  const started = service.submitInitialBoard(
    users[1],
    waiting.code,
    [6, 5, 4, 3, 2, 1],
  );

  assert.deepEqual(started.dice, [1, 2]);
  assert.equal(started.round, 1);
  assert.ok(started.players.every((player) => !player.playedThisRound));
  const firstPlayerBoard = service.getRoom(users[0], waiting.code).board;
  const secondPlayerBoard = service.getRoom(users[1], waiting.code).board;
  assert.notDeepEqual(firstPlayerBoard, secondPlayerBoard);

  const afterFirstMove = makeFirstValidMove(
    service,
    users[0],
    service.getRoom(users[0], waiting.code),
  );
  assert.equal(afterFirstMove.round, 1);
  assert.deepEqual(afterFirstMove.dice, [1, 2]);
  assert.equal(
    afterFirstMove.players.find((player) => player.id === users[0].id)?.playedThisRound,
    true,
  );
  assert.equal(
    afterFirstMove.players.find((player) => player.id === users[1].id)?.playedThisRound,
    false,
  );
  assert.deepEqual(service.getRoom(users[1], waiting.code).dice, [1, 2]);

  const afterSecondMove = makeFirstValidMove(
    service,
    users[1],
    started,
  );
  assert.equal(afterSecondMove.round, 2);
  assert.deepEqual(afterSecondMove.dice, [3, 4]);
  assert.deepEqual(service.getRoom(users[0], waiting.code).dice, [3, 4]);
  assert.ok(afterSecondMove.players.every((player) => !player.playedThisRound));
  assert.notDeepEqual(
    service.getRoom(users[0], waiting.code).board,
    service.getRoom(users[1], waiting.code).board,
  );
});

test("validates round ownership, adjacency, duplicate actions and game rules", () => {
  const service = createService();
  const waiting = service.createRoom(users[0], 1);
  service.joinRoom(users[1], waiting.code);
  const room = startAndConfigure(service, users[0], waiting.code, users.slice(0, 2), 1);
  assert.equal(room.board.flat().filter((value) => value !== null).length, 6);

  expectCode(
    () => service.playMove(users[0], room.code, {
      round: room.round - 1,
      anchorDieIndex: 0,
      anchor: { row: 0, column: 0 },
      destination: { row: 0, column: 1 },
      commandId: "00000000-0000-4000-8000-000000000001",
    }),
    "STALE_ROUND",
  );
  expectCode(
    () => service.playMove(users[0], room.code, {
      round: room.round,
      anchorDieIndex: 0,
      anchor: { row: 0, column: 0 },
      destination: { row: 0, column: 1 },
      commandId: "00000000-0000-4000-8000-000000000002",
    }),
    "INVALID_MOVE",
  );

  const afterMove = makeFirstValidMove(service, users[0], room);
  assert.equal(afterMove.board.flat().filter((value) => value !== null).length, 7);
  assert.ok(afterMove.revision > room.revision);
  assert.equal(afterMove.round, room.round);
  expectCode(
    () => service.skipRound(users[0], room.code, room.round),
    "ROUND_ALREADY_COMPLETED",
  );
  expectCode(
    () => service.skipRound(users[1], room.code, room.round - 1),
    "STALE_ROUND",
  );
  const afterOtherPlayerSkips = service.skipRound(
    users[1],
    room.code,
    room.round,
  );
  assert.equal(afterOtherPlayerSkips.round, room.round + 1);
});

test("a host leaving before start dissolves the room for all invitees", () => {
  const service = createService();
  const room = service.createRoom(users[0], 2);
  service.joinRoom(users[1], room.code);

  assert.equal(service.leaveRoom(users[0], room.code).dissolved, true);
  expectCode(() => service.getRoom(users[1], room.code), "ROOM_DISSOLVED");
});

test("a host leaving during setup dissolves the room for all players", () => {
  const service = createService();
  const room = service.createRoom(users[0], 2);
  service.joinRoom(users[1], room.code);
  service.startRoom(users[0], room.code);

  const result = service.leaveRoom(users[0], room.code);

  assert.equal(result.dissolved, true);
  assert.match(result.message ?? "", /anfitrión abandonó/);
  expectCode(() => service.getRoom(users[1], room.code), "ROOM_DISSOLVED");
});

test("a non-host leaving setup closes a room that no longer has enough players", () => {
  const service = createService();
  const room = service.createRoom(users[0], 1);
  service.joinRoom(users[1], room.code);
  service.startRoom(users[0], room.code);

  const result = service.leaveRoom(users[1], room.code);

  assert.equal(result.dissolved, true);
  assert.match(result.message ?? "", /suficientes jugadores/);
  expectCode(() => service.getRoom(users[0], room.code), "ROOM_DISSOLVED");
});

test("a host or player leaving during a game is removed while the game continues", () => {
  const service = createService();
  const waiting = service.createRoom(users[0], 3);
  service.joinRoom(users[1], waiting.code);
  service.joinRoom(users[2], waiting.code);
  startAndConfigure(service, users[0], waiting.code, users.slice(0, 3), 3);

  const result = service.leaveRoom(users[0], waiting.code).room!;
  assert.equal(result.phase, "playing");
  assert.deepEqual(result.winners, []);
  assert.equal(result.players.find((player) => player.id === users[0].id)?.forfeited, true);
  assert.equal(result.players.filter((player) => !player.forfeited).length, 2);
  assert.equal(makeFirstValidMove(service, users[1], result).phase, "playing");
});

test("a host disconnecting during a game is removed without ending the game", () => {
  let time = 0;
  let codeValue = 0;
  const service = new MultiplayerService(
    () => time,
    (max) => (max === 6 ? 0 : codeValue++ % max),
  );
  const waiting = service.createRoom(users[0], 1);
  service.joinRoom(users[1], waiting.code);

  time = 59_999;
  service.sweep();
  assert.equal(service.getRoom(users[1], waiting.code).phase, "waiting");

  time = 60_000;
  service.sweep();
  expectCode(() => service.getRoom(users[1], waiting.code), "ROOM_DISSOLVED");

  time = 100_000;
  const game = service.createRoom(users[0], 1);
  service.joinRoom(users[1], game.code);
  startAndConfigure(service, users[0], game.code, users.slice(0, 2), 1);
  time = 150_000;
  service.getRoom(users[1], game.code);
  time = 160_000;
  service.sweep();
  const state = service.getRoom(users[1], game.code);
  assert.equal(state.phase, "playing");
  assert.equal(state.players.find((player) => player.id === users[0].id)?.forfeited, true);
  assert.equal(state.players.find((player) => player.id === users[1].id)?.forfeited, false);
});

test("shows missed heartbeats and removes disconnected players after exactly 60 seconds", () => {
  let time = 0;
  const service = createService(() => time);
  const waiting = service.createRoom(users[0], 1);
  service.joinRoom(users[1], waiting.code);

  time = 6_001;
  const lobby = service.listLobby(users[0]);
  assert.deepEqual(lobby.activePlayers.map((player) => player.id), [users[0].id]);
  const state = service.getRoom(users[0], waiting.code);
  assert.equal(state.players.find((player) => player.id === users[1].id)?.connected, false);
  expectCode(() => service.startRoom(users[0], waiting.code), "PLAYER_RECONNECTING");
  assert.equal(service.getRoom(users[0], waiting.code).players.length, 2);

  time = 60_000;
  service.sweep();
  assert.equal(service.getRoom(users[0], waiting.code).players.length, 1);
});

test("lobby heartbeats do not keep a disconnected room player connected", () => {
  let time = 0;
  const service = createService(() => time);
  const waiting = service.createRoom(users[0], 1);
  service.joinRoom(users[1], waiting.code);
  startAndConfigure(service, users[0], waiting.code, users.slice(0, 2), 1);

  time = 30_000;
  service.getRoom(users[0], waiting.code);
  service.listLobby(users[1]);
  time = 60_000;
  service.getRoom(users[0], waiting.code);

  const state = service.getRoom(users[0], waiting.code);
  assert.equal(state.phase, "playing");
  assert.equal(
    state.players.find((player) => player.id === users[1].id)?.forfeited,
    true,
  );
});

test("a setup player is removed after 60 seconds and remaining players are informed", () => {
  let time = 0;
  const service = createService(() => time);
  const waiting = service.createRoom(users[0], 1);
  service.joinRoom(users[1], waiting.code);
  service.joinRoom(users[2], waiting.code);
  service.startRoom(users[0], waiting.code);
  service.submitInitialBoard(users[0], waiting.code, [1, 2, 3, 4, 5, 6]);

  time = 59_000;
  service.getRoom(users[0], waiting.code);
  service.getRoom(users[2], waiting.code);
  time = 60_000;
  const state = service.getRoom(users[0], waiting.code);

  assert.equal(state.phase, "setup");
  assert.equal(
    state.players.find((player) => player.id === users[1].id)?.forfeited,
    true,
  );
  assert.ok(
    state.events.some((event) =>
      event.message.includes("no se reconectó en 60 segundos"),
    ),
  );
});

test("holds the shared round until a disconnected player reconnects or forfeits", () => {
  let time = 0;
  let codeValue = 0;
  const service = new MultiplayerService(
    () => time,
    (max) => (max === 6 ? 0 : codeValue++ % max),
  );
  const waiting = service.createRoom(users[0], 1);
  service.joinRoom(users[1], waiting.code);
  const room = startAndConfigure(service, users[0], waiting.code, users.slice(0, 2), 1);
  const disconnectedPlayer = users[1];
  const connectedPlayer = users[0];

  time = 6_001;
  service.listLobby(connectedPlayer);
  const updated = service.getRoom(connectedPlayer, waiting.code);
  assert.equal(updated.phase, "playing");
  assert.equal(updated.round, room.round);
  assert.equal(updated.players.find((player) => player.id === disconnectedPlayer.id)?.connected, false);
  assert.ok(updated.dice);
  const afterConnectedPlayerMoves = makeFirstValidMove(
    service,
    connectedPlayer,
    updated,
  );
  assert.equal(afterConnectedPlayerMoves.round, room.round);
  assert.deepEqual(afterConnectedPlayerMoves.dice, room.dice);
  assert.equal(
    afterConnectedPlayerMoves.players.find((player) => player.id === disconnectedPlayer.id)?.playedThisRound,
    false,
  );
});

test("ends without winners only when every player disconnects", () => {
  let time = 0;
  const service = createService(() => time);
  const waiting = service.createRoom(users[0], 1);
  service.joinRoom(users[1], waiting.code);
  startAndConfigure(service, users[0], waiting.code, users.slice(0, 2), 1);

  time = 60_001;
  service.sweep();
  const finalState = service.getRoom(users[0], waiting.code);
  assert.equal(finalState.phase, "finished");
  assert.deepEqual(finalState.winners, []);
});

test("limits repeated invite-code guesses per authenticated account", () => {
  const service = createService();
  service.createRoom(users[0], 1);
  for (let attempt = 0; attempt < 10; attempt++) {
    expectCode(() => service.joinRoom(users[1], "ZZZZZZ"), "ROOM_NOT_FOUND");
  }
  expectCode(() => service.joinRoom(users[1], "ZZZZZZ"), "JOIN_RATE_LIMITED");
});

test("limits room creation bursts even when the host immediately dissolves rooms", () => {
  const service = createService();
  for (let attempt = 0; attempt < 3; attempt++) {
    const room = service.createRoom(users[0], 1);
    service.leaveRoom(users[0], room.code);
  }
  expectCode(() => service.createRoom(users[0], 1), "CREATE_RATE_LIMITED");
});
