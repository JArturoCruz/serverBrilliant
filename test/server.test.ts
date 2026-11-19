import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createSocket } from "node:dgram";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { betterAuth } from "better-auth";
import { getMigrations } from "better-auth/db/migration";

for (const legacy of [false, true]) test(
  `servidor ${legacy ? "con cuentas existentes" : "nuevo"} admite cuentas y multijugador`,
  async () => {
  const directory = await mkdtemp(join(tmpdir(), "brilliant-server-test-"));
  const listener = createServer();
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const address = listener.address();
  assert(address && typeof address !== "string");
  const port = address.port;
  await new Promise<void>((resolve, reject) =>
    listener.close((error) => error ? reject(error) : resolve()),
  );
  const socket = createSocket("udp4");
  await new Promise<void>((resolve) => socket.bind(0, "127.0.0.1", resolve));
  const discoveryPort = socket.address().port;
  socket.close();

  const base = `http://127.0.0.1:${port}`;
  const origin = "http://localhost:5000";
  const webRoot = join(directory, "web");
  await mkdir(webRoot);
  await writeFile(join(webRoot, "index.html"), "<html>Brilliant web</html>");
  await writeFile(join(webRoot, "app.js"), "console.log('app');");
  if (legacy) {
    const database = new DatabaseSync(join(directory, "auth.sqlite"));
    const previousAuth = betterAuth({
      database,
      baseURL: base,
      secret: "test-secret-with-more-than-thirty-two-characters",
      emailAndPassword: { enabled: true },
    });
    const migrations = await getMigrations(previousAuth.options);
    await migrations.runMigrations();
    await previousAuth.api.signUpEmail({
      body: { name: "Old Player", email: "old@example.test", password: "Old-Password12" },
    });
    database.close();
  }
  const process = spawn(globalThis.process.execPath, [
    fileURLToPath(new URL("../server.js", import.meta.url)),
  ], {
    cwd: directory,
    env: {
      ...globalThis.process.env,
      PORT: String(port),
      DISCOVERY_PORT: String(discoveryPort),
      SQLITE_PATH: join(directory, "auth.sqlite"),
      BETTER_AUTH_URL: base,
      BETTER_AUTH_SECRET: "test-secret-with-more-than-thirty-two-characters",
      CLIENT_ORIGINS: origin,
      BRILLIANT_WEB_ROOT: webRoot,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  process.stdout.on("data", (data: Buffer) => { output += data.toString(); });
  process.stderr.on("data", (data: Buffer) => { output += data.toString(); });
  const exited = once(process, "exit");

  try {
    let healthy = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (process.exitCode !== null) throw new Error(`El servidor terminó: ${output}`);
      try {
        const response = await fetch(`${base}/health`, { headers: { origin } });
        if (response.ok) {
          assert.equal(response.headers.get("access-control-allow-origin"), origin);
          assert.deepEqual(await response.json(), { status: "ok", service: "brilliant" });
          healthy = true;
          break;
        }
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    assert.ok(healthy, `El servidor no inició: ${output}`);
    const page = await fetch(`${base}/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Brilliant web/);
    assert.match(page.headers.get("content-security-policy") ?? "", /wasm-unsafe-eval/);
    const asset = await fetch(`${base}/app.js`);
    assert.equal(asset.status, 200);
    assert.match(await asset.text(), /console/);
    const missingApi = await fetch(`${base}/api/multiplayer/does-not-exist`);
    assert.equal(missingApi.status, 404);
    assert.doesNotMatch(await missingApi.text(), /Brilliant web/);

    const preflight = await fetch(`${base}/health`, {
      method: "OPTIONS",
      headers: {
        origin,
        "access-control-request-method": "GET",
        "access-control-request-headers": "ngrok-skip-browser-warning",
        "access-control-request-private-network": "true",
      },
    });
    assert.equal(preflight.headers.get("access-control-allow-private-network"), "true");
    assert.match(preflight.headers.get("access-control-allow-headers") ?? "", /ngrok-skip-browser-warning/i);
    const blockedPreflight = await fetch(`${base}/health`, {
      method: "OPTIONS",
      headers: {
        origin: "http://untrusted.example",
        "access-control-request-method": "GET",
        "access-control-request-private-network": "true",
      },
    });
    assert.equal(blockedPreflight.headers.get("access-control-allow-private-network"), null);

    const discovery = createSocket("udp4");
    try {
      await new Promise<void>((resolve) => discovery.bind(0, "127.0.0.1", resolve));
      const nonce = "0123456789abcdef0123456789abcdef";
      const reply = new Promise<string>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Sin respuesta UDP")), 3000);
        discovery.once("message", (message) => {
          clearTimeout(timeout);
          resolve(message.toString());
        });
      });
      discovery.send(`BRILLIANT_DISCOVER_V1:${nonce}`, discoveryPort, "127.0.0.1");
      assert.equal(await reply, `BRILLIANT_SERVER_V1:${nonce}:${port}`);
    } finally {
      discovery.close();
    }

    async function request(path: string, method: string, body?: object, token?: string) {
      return fetch(`${base}${path}`, {
        method,
        headers: {
          origin,
          ...(body ? { "content-type": "application/json" } : {}),
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    }

    async function register(name: string, email: string, password = "123456"): Promise<string> {
      const response = await request("/api/auth/sign-up/email", "POST", {
        name, username: name, email, password,
      });
      assert.equal(response.status, 200, `${await response.clone().text()}\n${output}`);
      const data = await response.json() as { token: string };
      assert.ok(data.token);
      return data.token;
    }

    const hostToken = await register("Host Player", "host@example.test", "001234");
    const guestToken = await register("Guest Player", "guest@example.test");
    const duplicate = await request("/api/auth/sign-up/email", "POST", {
      name: "HOST PLAYER", username: "HOST PLAYER", email: "duplicate@example.test", password: "123456",
    });
    assert.ok(duplicate.status >= 400 && duplicate.status < 500);
    const invalid = await request("/api/auth/sign-up/email", "POST", {
      name: "Invalid Player", username: "Invalid Player", email: "invalid@example.test", password: "12345a",
    });
    assert.equal(invalid.status, 400);
    const tooLong = await request("/api/auth/sign-up/email", "POST", {
      name: "Long Pin", username: "Long Pin", email: "long@example.test", password: "1234567",
    });
    assert.equal(tooLong.status, 400);
    const login = await request("/api/auth/sign-in/username", "POST", {
      username: "host player", password: "001234",
    });
    assert.equal(login.status, 200, await login.clone().text());
    if (legacy) {
      const oldLogin = await request("/api/auth/sign-in/username", "POST", {
        username: "old player", password: "Old-Password12",
      });
      assert.equal(oldLogin.status, 200, await oldLogin.clone().text());
    }
    const session = await request("/api/auth/get-session", "GET", undefined, hostToken);
    assert.equal(session.status, 200);
    const room = await request("/api/multiplayer/rooms", "POST", { mapId: 1 }, hostToken);
    assert.equal(room.status, 201, await room.clone().text());
    const { code } = await room.json() as { code: string };
    const joinRoom = await request(`/api/multiplayer/rooms/${code}/join`, "POST", {}, guestToken);
    assert.equal(joinRoom.status, 200, await joinRoom.clone().text());
    const joined = await joinRoom.json() as { players: Array<{ id: string; isHost: boolean }> };
    const guestId = joined.players.find((player) => !player.isHost)!.id;
    const startPath = `/api/multiplayer/rooms/${code}/start`;
    const readyPath = `/api/multiplayer/rooms/${code}/ready`;
    const removePath = `/api/multiplayer/rooms/${code}/remove-player`;
    assert.equal((await request(startPath, "POST", {}, hostToken)).status, 409);
    assert.equal((await request(readyPath, "POST", { ready: "true" }, hostToken)).status, 400);
    assert.equal((await request(removePath, "POST", { playerId: guestId, block: false }, guestToken)).status, 403);
    assert.equal((await request(removePath, "POST", { playerId: guestId, block: "false" }, hostToken)).status, 400);
    assert.equal((await request(removePath, "POST", { playerId: guestId, block: false }, hostToken)).status, 200);
    const kicked = await request(`/api/multiplayer/rooms/${code}`, "GET", undefined, guestToken);
    assert.equal(kicked.status, 403);
    assert.equal((await kicked.json() as { code: string }).code, "ROOM_KICKED");
    assert.equal((await request(`/api/multiplayer/rooms/${code}/join`, "POST", {}, guestToken)).status, 200);
    assert.equal((await request(readyPath, "POST", { ready: true }, hostToken)).status, 200);
    assert.equal((await request(readyPath, "POST", { ready: true }, guestToken)).status, 200);
    assert.equal((await request(startPath, "POST", {}, hostToken)).status, 200);
    assert.equal((await request(removePath, "POST", { playerId: guestId, block: true }, hostToken)).status, 409);
    const lobby = await request("/api/multiplayer/lobby", "GET", undefined, guestToken);
    assert.equal(lobby.status, 200);
    const blocked = await fetch(`${base}/health`, { headers: { origin: "http://untrusted.example" } });
    assert.equal(blocked.headers.get("access-control-allow-origin"), null);
  } finally {
    process.kill();
    await exited;
    await rm(directory, { recursive: true, force: true });
  }
});
