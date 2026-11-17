/**
 * The open inbox and the notifications across restarts of a real server process, and an agent's
 * terminal waiting for a window to ask in: what `server.ts` wires up around open-inbox.ts,
 * notification-store.ts and agent-terminals.ts. `LOXEL_DEV=1` keeps the server off the
 * keychain, and a temporary state directory off the user's projects.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { GlobalRegistrator } from "@happy-dom/global-registrator";

import type { WsMessage } from "@/api/ws-protocol";
import { cliSocketPath } from "@/socket-paths";
import { CaptureLog } from "@/test/git-sync-harness";

// The package's test preload replaces `fetch` and `WebSocket` with browser ones, which have no
// `unix` option and enforce CORS.
if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();

const LOXEL_ROOT = path.resolve(import.meta.dir, "../..");
const TEST_TIMEOUT_MS = 120_000;

/** A port free right now: the server takes its port from the environment. */
function freePort(): number {
  const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data: () => {} } });
  const { port } = listener;
  listener.stop(true);
  return port;
}

/** A server process for `stateDir`, once it answers on its loopback port. */
async function startServer(stateDir: string) {
  const port = freePort();
  const server = Bun.spawn(["bun", "src/server/index.ts"], {
    cwd: LOXEL_ROOT,
    env: {
      ...process.env,
      LOXEL_DEV: "1",
      LOXEL_STATE_DIR: stateDir,
      LOXEL_SERVE_PORT: String(port),
    },
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  // Polled: the server signals nothing else when it starts listening.
  while (!(await fetch(`http://127.0.0.1:${port}/api/version`).catch(() => null))?.ok) {
    if (server.exitCode !== null) throw new Error(`Server exited: ${server.exitCode}`);
    await Bun.sleep(50);
  }
  return { server, port };
}

async function stopServer(server: ReturnType<typeof Bun.spawn>): Promise<void> {
  server.kill("SIGTERM");
  await server.exited;
}

/** An app window's socket, recording every message the server sends it. */
async function connectWindow(port: number) {
  const log = new CaptureLog<WsMessage>();
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  ws.addEventListener("message", (event) => {
    log.add(JSON.parse(String(event.data)) as WsMessage);
  });
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve);
    ws.addEventListener("error", () => reject(new Error("WebSocket error")));
  });
  return { ws, log };
}

/** The first message of `type` the window got. */
async function received<K extends WsMessage["type"]>(
  log: CaptureLog<WsMessage>,
  type: K,
): Promise<Extract<WsMessage, { type: K }>> {
  const seq = await log.waitFor((message) => message.type === type, { label: type });
  return log.entries[seq] as Extract<WsMessage, { type: K }>;
}

describe("a server with no window connected", () => {
  let stateDir: string;
  let file: string;
  let current: Awaited<ReturnType<typeof startServer>> | null = null;

  const overSocket = (body: unknown) =>
    fetch("http://localhost/api/open", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      unix: cliSocketPath(stateDir),
    });

  beforeAll(() => {
    stateDir = realpathSync(mkdtempSync(path.join(tmpdir(), "loxel-open-inbox-")));
    file = path.join(stateDir, "plan.md");
    writeFileSync(file, "# plan\n");
  });

  afterAll(() => {
    current?.server.kill("SIGKILL");
    rmSync(stateDir, { recursive: true, force: true });
  });

  test(
    "keeps an open for the next window, across a restart, and tells it what opened",
    async () => {
      current = await startServer(stateDir);
      const res = await overSocket({ filePath: file, focus: false, queue: true });
      expect(res.status).toBe(202);
      expect(await res.json()).toEqual({ ok: true, queued: true });
      // Without `queue`, as from an older CLI or the app itself, it still waits for a window.
      expect((await overSocket({ filePath: file })).status).toBe(503);
      // A terminal starts at once, and its shell ends with this server (SIGTERM ends terminals): the
      // next server drops its panel rather than show a new shell in it.
      const terminal = await overSocket({ terminal: { cwd: stateDir }, queue: true });
      expect(terminal.status).toBe(202);
      await stopServer(current.server);

      current = await startServer(stateDir);
      const windowA = crypto.randomUUID();
      const hello = (windowId: string) => JSON.stringify({ type: "window_hello", windowId });
      const { ws, log } = await connectWindow(current.port);
      ws.send(hello(windowA));
      const delivered = await received(log, "open_from_inbox");
      expect(delivered.message).toEqual({
        type: "open_file",
        data: { filePath: file, focus: false },
      });
      const added = await received(log, "notification_added");
      expect(added.data).toMatchObject({
        title: "A file opened while you were away",
        body: "plan.md",
      });
      // Outside every worktree, the file opened in what the window showed.
      expect(added.data.source).toEqual({ kind: "inbox" });
      // The notification follows every delivery, so a terminal would have come before it.
      expect(
        log.entries.filter((message) => message.type === "open_from_inbox").map((m) => m.message),
      ).toEqual([delivered.message]);

      /** What `window` was sent until now: the server answers a socket's messages in order. */
      const fence = async (window: Awaited<ReturnType<typeof connectWindow>>) => {
        window.ws.send(JSON.stringify({ type: "subscribe_logs" }));
        await received(window.log, "log_error_snapshot");
      };
      // A reloads before it places the panel: it gets the request again, with no second
      // notification.
      ws.close();
      const reloaded = await connectWindow(current.port);
      reloaded.ws.send(hello(windowA));
      expect(await received(reloaded.log, "open_from_inbox")).toEqual(delivered);
      await fence(reloaded);
      expect(reloaded.log.entries.some((m) => m.type === "notification_added")).toBe(false);
      // A window that says hello while A is away takes it over, and A is told when it is back, so
      // it does not open it too.
      reloaded.ws.close();
      const windowB = await connectWindow(current.port);
      windowB.ws.send(hello(crypto.randomUUID()));
      expect(await received(windowB.log, "open_from_inbox")).toEqual(delivered);
      const back = await connectWindow(current.port);
      back.ws.send(hello(windowA));
      expect(await received(back.log, "inbox_open_revoked")).toEqual({
        type: "inbox_open_revoked",
        inboxIds: [delivered.inboxId],
      });
      await fence(back);
      expect(back.log.entries.some((m) => m.type === "open_from_inbox")).toBe(false);
      back.ws.close();
      windowB.ws.send(JSON.stringify({ type: "inbox_open_done", inboxId: delivered.inboxId }));
      await fence(windowB);
      windowB.ws.close();
      await stopServer(current.server);

      // Done with once placed, and the notification outlives another restart.
      current = await startServer(stateDir);
      const next = await connectWindow(current.port);
      next.ws.send(hello(crypto.randomUUID()));
      expect((await received(next.log, "notifications_sync")).data).toEqual([added.data]);
      await fence(next);
      expect(next.log.entries.some((message) => message.type === "open_from_inbox")).toBe(false);
      next.ws.close();
    },
    TEST_TIMEOUT_MS,
  );
});

describe("an agent's terminal with Ask and no window connected", () => {
  let stateDir: string;
  let current: Awaited<ReturnType<typeof startServer>> | null = null;

  beforeAll(() => {
    stateDir = realpathSync(mkdtempSync(path.join(tmpdir(), "loxel-agent-ask-")));
  });

  afterAll(() => {
    current?.server.kill("SIGKILL");
    rmSync(stateDir, { recursive: true, force: true });
  });

  test(
    "waits for the next window to say hello, asks there, and runs once it says Run",
    async () => {
      current = await startServer(stateDir);
      // "When an Agent Starts a Terminal" is Ask, as a window saves it.
      const saved = await fetch(`http://127.0.0.1:${current.port}/api/stores/settings`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          value: JSON.stringify({ state: { terminal: { agentTerminals: "ask" } }, version: 1 }),
        }),
      });
      expect(saved.ok).toBe(true);
      const agent = { agent: "Claude Code" };
      const res = await fetch("http://localhost/api/open", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ terminal: { cwd: stateDir, command: "true" }, agent, queue: true }),
        unix: cliSocketPath(stateDir),
      });
      expect(res.status).toBe(202);
      expect(await res.json()).toEqual({ ok: true, asked: true, queued: true });

      const { ws, log } = await connectWindow(current.port);
      const windowId = crypto.randomUUID();
      ws.send(JSON.stringify({ type: "window_hello", windowId }));
      const seq = await log.waitFor(
        (message) =>
          message.type === "agent_terminals_changed" && message.data.asks[0]?.windowId === windowId,
        { label: "the ask, in this window" },
      );
      const changed = log.entries[seq] as Extract<WsMessage, { type: "agent_terminals_changed" }>;
      const [ask] = changed.data.asks;
      expect(ask).toMatchObject({ origin: agent, cwd: stateDir, command: "true" });
      // Nothing started while it waited.
      expect(log.entries.some((message) => message.type === "open_terminal")).toBe(false);

      const answer = await fetch(`http://127.0.0.1:${current.port}/api/agent-terminals/answer`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: ask!.id, answer: "run", windowId }),
      });
      expect(answer.status).toBe(200);
      expect((await received(log, "open_terminal")).data).toMatchObject({
        cwd: stateDir,
        origin: agent,
      });
      ws.close();
      // SIGTERM ends the terminal it started; a killed server's terminal host would outlive it.
      await stopServer(current.server);
    },
    TEST_TIMEOUT_MS,
  );
});
