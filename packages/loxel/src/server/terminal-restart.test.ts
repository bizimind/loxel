/**
 * Terminals outlive their server: a real server process is killed while a shell runs, and the next
 * server reattaches the panel to the same shell, resuming its stream or, for a fresh xterm, with a
 * snapshot. A quit (SIGTERM) still ends them. A server started as the desktop app starts it, with
 * the app's channel, keeps them on a shutdown with `keep` (Quit and Keep Terminals, Restart
 * Loxel, an update) and when the app goes away, and ends them on one with `end`. A shell that
 * exits while no server is connected shows the next one its last output and real exit code. `LOXEL_DEV=1`
 * keeps the server off the keychain, and a temporary state directory and port keep it and its
 * terminal host apart from any real one.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  closeSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import path from "node:path";

import { GlobalRegistrator } from "@happy-dom/global-registrator";

import { RunningTerminalsSchema } from "@/api/running-terminals-model";
import { encodeInputFrame, parseOutputFrame } from "@/api/terminal-stream";
import type { WsMessage } from "@/api/ws-protocol";
import {
  PARENT_CHANNEL_FD,
  type ShutdownTerminals,
  encodeParentMessage,
} from "@/parent-channel-protocol";
import { hostLogsDir, hostRunDir } from "@/terminal-host/host-files";
import { retryUntil } from "@/test/git-sync-harness";
import { until } from "@/test/until";

// The package's test preload replaces `fetch` and `WebSocket` with browser ones that enforce CORS.
if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();

const LOXEL_ROOT = path.resolve(import.meta.dir, "../..");
const TEST_TIMEOUT_MS = 60_000;

function freePort(): number {
  const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data: () => {} } });
  const { port } = listener;
  listener.stop(true);
  return port;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** A panel's view of one terminal over its own socket: states, output, exits and its offset. */
async function openPanel(baseUrl: string) {
  const states: Array<Extract<WsMessage, { type: "terminal_state" }>> = [];
  const exits: Array<Extract<WsMessage, { type: "terminal_exit" }>> = [];
  let text = "";
  let offset: number | null = null;
  const socket = new WebSocket(baseUrl.replace("http", "ws") + "/ws");
  socket.binaryType = "arraybuffer";
  socket.addEventListener("message", (event) => {
    if (typeof event.data !== "string") {
      const frame = parseOutputFrame(new Uint8Array(event.data as ArrayBuffer));
      if (!frame) return;
      text += new TextDecoder().decode(frame.payload);
      offset = frame.offset + frame.payload.byteLength;
      return;
    }
    const message = JSON.parse(event.data) as WsMessage;
    if (message.type === "terminal_exit") exits.push(message);
    if (message.type !== "terminal_state") return;
    states.push(message);
    offset = message.offset;
  });
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve);
    socket.addEventListener("error", reject);
  });
  return {
    states,
    exits,
    text: () => text,
    offset: () => offset,
    attach: (id: string, since?: { epoch: string; offset: number }) =>
      socket.send(
        JSON.stringify({
          type: "terminal_attach",
          id,
          cols: 80,
          rows: 24,
          cwd: "/tmp",
          worktreePath: "/tmp",
          ...(since && { sinceEpoch: since.epoch, sinceOffset: since.offset }),
        }),
      ),
    type: (id: string, line: string) =>
      socket.send(new Uint8Array(encodeInputFrame(id, new TextEncoder().encode(`${line}\n`)))),
    close: () => socket.close(),
  };
}

describe("terminals across server restarts", () => {
  let stateDir: string;
  let baseUrl: string;
  let port: number;
  let server: { exited: Promise<number>; kill: (signal: NodeJS.Signals) => void } | null = null;
  /** The descriptor of the app's channel to the server, for one started as the app starts it. */
  let appChannel: number | null = null;

  /**
   * Start a server: on its own, or `asApp`, as the desktop app does (this process its parent, with
   * the app's channel).
   */
  async function startServer({ asApp = false } = {}): Promise<void> {
    const started = Bun.spawn(["bun", "src/server/index.ts"], {
      cwd: LOXEL_ROOT,
      env: {
        ...process.env,
        LOXEL_DEV: "1",
        LOXEL_STATE_DIR: stateDir,
        LOXEL_SERVE_PORT: String(port),
        SHELL: "/bin/sh",
        ...(asApp && { LOXEL_PARENT_PID: String(process.pid) }),
      },
      stdio: ["ignore", "ignore", "ignore", asApp ? "pipe" : "ignore"],
    });
    server = started;
    const channel = started.stdio[PARENT_CHANNEL_FD];
    appChannel = typeof channel === "number" ? channel : null;
    await retryUntil(
      () => {},
      async (timeoutMs) => {
        if (started.exitCode !== null) throw new Error(`Server exited: ${started.exitCode}`);
        if ((await fetch(`${baseUrl}/api/version`).catch(() => null))?.ok) return true;
        await Bun.sleep(timeoutMs);
        return false;
      },
      "the server to listen",
    );
  }

  /** Everything the terminal hosts have logged. */
  function hostLogs(): string {
    const logsDir = hostLogsDir(stateDir);
    if (!existsSync(logsDir)) return "";
    return readdirSync(logsDir)
      .filter((name) => name.startsWith("terminal-host-") && name.endsWith(".log"))
      .map((name) => readFileSync(path.join(logsDir, name), "utf8"))
      .join("");
  }

  /** The PIDs of the running terminal hosts, from their entries. */
  function hostPids(): number[] {
    const runDir = hostRunDir(stateDir);
    if (!existsSync(runDir)) return [];
    return readdirSync(runDir)
      .filter((name) => name.endsWith(".json"))
      .map(
        (name) =>
          (JSON.parse(readFileSync(path.join(runDir, name), "utf8")) as { pid: number }).pid,
      );
  }

  beforeAll(() => {
    // Short, so the host's socket path fits the platform limit without the fallback.
    stateDir = realpathSync(mkdtempSync("/tmp/lx-restart-"));
    port = freePort();
    baseUrl = `http://127.0.0.1:${port}`;
  });

  /** What the app sends as it quits: the server shuts down, doing `terminals` to the terminals. */
  async function quitApp(terminals: ShutdownTerminals): Promise<void> {
    writeSync(appChannel!, encodeParentMessage({ type: "shutdown", terminals }));
    closeSync(appChannel!);
    expect(await server!.exited).toBe(0);
  }

  /** A panel with a shell in a new terminal, whose PID it has read. */
  async function openShell() {
    const id = crypto.randomUUID();
    const panel = await openPanel(baseUrl);
    panel.attach(id);
    await until(() => panel.states.length > 0, TEST_TIMEOUT_MS);
    const pidFile = path.join(stateDir, `${id}.pid`);
    panel.type(id, `echo $$ > ${pidFile}; echo started`);
    await until(() => panel.text().includes("started\r\n"), TEST_TIMEOUT_MS);
    const shellPid = Number(readFileSync(pidFile, "utf8"));
    return { id, panel, shellPid, epoch: panel.states[0]!.epoch };
  }

  /** Reattach the panel of `shell` to a new server, which resumes its stream at the same shell. */
  async function expectResumed(shell: Awaited<ReturnType<typeof openShell>>): Promise<void> {
    const since = { epoch: shell.epoch, offset: shell.panel.offset()! };
    const resumed = await openPanel(baseUrl);
    resumed.attach(shell.id, since);
    await until(() => resumed.states.length > 0, TEST_TIMEOUT_MS);
    expect(resumed.states[0]).toMatchObject({
      epoch: shell.epoch,
      mode: "resume",
      offset: since.offset,
    });
    resumed.type(shell.id, "echo $$ resumed");
    await until(() => resumed.text().includes(`${shell.shellPid} resumed`), TEST_TIMEOUT_MS);
    resumed.close();
  }

  afterAll(async () => {
    server?.kill("SIGKILL");
    await server?.exited;
    // Whatever the test left running ends with its host.
    for (const pid of hostPids()) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        // Already gone.
      }
    }
    rmSync(stateDir, { recursive: true, force: true });
  });

  test(
    "a killed server leaves the shell running, and the next server resumes it",
    async () => {
      await startServer();
      const id = crypto.randomUUID();
      const first = await openPanel(baseUrl);
      first.attach(id);
      await until(() => first.states.length > 0, TEST_TIMEOUT_MS);
      const pidFile = path.join(stateDir, "shell.pid");
      first.type(id, `echo $$ > ${pidFile}; echo before-crash`);
      await until(() => first.text().includes("before-crash\r\n"), TEST_TIMEOUT_MS);
      const shellPid = Number(readFileSync(pidFile, "utf8"));
      const epoch = first.states[0]!.epoch;

      // A crash: no shutdown, no disconnect.
      server!.kill("SIGKILL");
      await server!.exited;
      expect(isAlive(shellPid)).toBe(true);
      const since = { epoch, offset: first.offset()! };

      await startServer();
      const resumed = await openPanel(baseUrl);
      resumed.attach(id, since);
      await until(() => resumed.states.length > 0, TEST_TIMEOUT_MS);
      expect(resumed.states[0]).toMatchObject({ epoch, mode: "resume", offset: since.offset });
      resumed.type(id, "echo $$ after-restart");
      await until(() => resumed.text().includes(`${shellPid} after-restart`), TEST_TIMEOUT_MS);
      resumed.close();

      // A fresh xterm gets the screen as a snapshot, with what the shell printed before the crash.
      const fresh = await openPanel(baseUrl);
      fresh.attach(id);
      await until(() => fresh.states.length > 0, TEST_TIMEOUT_MS);
      expect(fresh.states[0]).toMatchObject({ epoch, mode: "snapshot" });
      expect(fresh.states[0]!.snapshot).toContain("before-crash");
      fresh.close();

      // A quit still ends the terminals, and the host with them.
      const hosts = hostPids();
      expect(hosts.length).toBe(1);
      server!.kill("SIGTERM");
      await server!.exited;
      await until(() => !isAlive(shellPid) && hosts.every((pid) => !isAlive(pid)), TEST_TIMEOUT_MS);
    },
    TEST_TIMEOUT_MS * 3,
  );

  test(
    "Quit and Keep Terminals and Restart Loxel keep the shell running for the next server",
    async () => {
      await startServer({ asApp: true });
      const shell = await openShell();
      const hosts = hostPids();

      await quitApp("keep");
      expect(isAlive(shell.shellPid)).toBe(true);
      expect(hosts.every(isAlive)).toBe(true);

      await startServer({ asApp: true });
      await expectResumed(shell);

      // A Quit ends the terminals, and the host with them.
      await quitApp("end");
      await until(
        () => !isAlive(shell.shellPid) && hosts.every((pid) => !isAlive(pid)),
        TEST_TIMEOUT_MS,
      );
    },
    TEST_TIMEOUT_MS * 3,
  );

  test(
    "lists the running terminals, with the program in each one's foreground",
    async () => {
      await startServer();
      const shell = await openShell();
      const list = async (query = "") =>
        RunningTerminalsSchema.parse(await (await fetch(`${baseUrl}/api/terminals${query}`)).json())
          .terminals;

      expect(await list()).toEqual([
        { id: shell.id, worktreePath: "/tmp", cwd: "/tmp", otherHostBuild: false },
      ]);
      expect((await list("?programs"))[0]?.program).toBeNull();

      // The shell runs it as a job, in a foreground process group of its own.
      shell.panel.type(shell.id, "sleep 30");
      await retryUntil(
        () => {},
        async (timeoutMs) => {
          if ((await list("?programs"))[0]?.program === "sleep") return true;
          await Bun.sleep(timeoutMs);
          return false;
        },
        "the foreground program",
      );

      shell.panel.close();
      server!.kill("SIGTERM");
      await server!.exited;
      await until(() => !isAlive(shell.shellPid), TEST_TIMEOUT_MS);
    },
    TEST_TIMEOUT_MS * 3,
  );

  test(
    "a shell that exits while the server is down shows the next one its last output and exit code",
    async () => {
      await startServer();
      const shell = await openShell();
      const go = path.join(stateDir, "finish.go");
      // Sourced, so its exit ends the shell itself, once told to; typed as a short line, so the
      // shell's echo of it does not wrap.
      const script = path.join(stateDir, "f.sh");
      writeFileSync(script, `while [ ! -e ${go} ]; do sleep 0.05; done; echo last-words; exit 7\n`);
      shell.panel.type(shell.id, `. ${script}`);
      await until(() => shell.panel.text().includes(`${script}\r\n`), TEST_TIMEOUT_MS);
      const since = { epoch: shell.epoch, offset: shell.panel.offset()! };

      server!.kill("SIGKILL");
      await server!.exited;
      // The host has seen the server go before the shell ends.
      await until(
        () => hostLogs().includes("The server's connection closed without a disconnect"),
        TEST_TIMEOUT_MS,
      );
      writeFileSync(go, "");
      await until(() => !isAlive(shell.shellPid), TEST_TIMEOUT_MS);

      await startServer();
      // Known ended before any panel reattaches: no longer listed as running.
      const listed = RunningTerminalsSchema.parse(
        await (await fetch(`${baseUrl}/api/terminals`)).json(),
      );
      expect(listed.terminals).toEqual([]);
      const resumed = await openPanel(baseUrl);
      resumed.attach(shell.id, since);
      await until(() => resumed.exits.length > 0, TEST_TIMEOUT_MS);
      expect(resumed.states[0]).toMatchObject({ epoch: shell.epoch, mode: "resume" });
      expect(resumed.text()).toContain("last-words");
      expect(resumed.exits).toEqual([
        { type: "terminal_exit", id: shell.id, reason: "exited", exitCode: 7, outputLost: false },
      ]);
      resumed.close();
      server!.kill("SIGTERM");
      await server!.exited;
    },
    TEST_TIMEOUT_MS * 3,
  );

  test(
    "an app that goes away without a word leaves the shell to the next server",
    async () => {
      await startServer({ asApp: true });
      const shell = await openShell();

      // Electron crashed: its end of the channel closes with no shutdown message.
      closeSync(appChannel!);
      expect(await server!.exited).toBe(0);
      expect(isAlive(shell.shellPid)).toBe(true);

      await startServer({ asApp: true });
      await expectResumed(shell);
      await quitApp("end");
      await until(() => !isAlive(shell.shellPid), TEST_TIMEOUT_MS);
    },
    TEST_TIMEOUT_MS * 3,
  );
});
