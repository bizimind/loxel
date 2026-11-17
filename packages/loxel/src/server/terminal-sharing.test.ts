/**
 * Several windows show one terminal at once: a real server, with one socket per window. Each gets
 * the output, the one its user last typed in (or resized, or attached alone) sets the PTY's size
 * and has its input written, one that opens it meanwhile joins without resizing it, and one
 * leaving, or closing its panel, leaves the shell running for the others. `LOXEL_DEV=1` keeps the server off the keychain, and a temporary state directory and
 * port keep it and its terminal host apart from any real one.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import path from "node:path";

import { GlobalRegistrator } from "@happy-dom/global-registrator";

import { RunningTerminalsSchema } from "@/api/running-terminals-model";
import { sessionAuthorization } from "@/session-client";
import { hostRunDir } from "@/terminal-host/host-files";
import { freePort, openPanel } from "@/test/terminal-panel";
import { until } from "@/test/until";

// The package's test preload replaces `fetch` and `WebSocket` with browser ones that enforce CORS.
if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();

const LOXEL_ROOT = path.resolve(import.meta.dir, "../..");
const TEST_TIMEOUT_MS = 60_000;

type Panel = Awaited<ReturnType<typeof openPanel>>;

/** Wait until `check` holds, for state only a request can read. */
async function eventually(check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + TEST_TIMEOUT_MS;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for condition");
    await Bun.sleep(50);
  }
}

describe("a terminal shown in several windows", () => {
  let stateDir: string;
  let baseUrl: string;
  /** The header with the server's session secret, from its token file. */
  let auth: { Authorization: string };
  let server: ReturnType<typeof Bun.spawn> | null = null;

  beforeAll(async () => {
    // Short, so the host's socket path fits the platform limit without the fallback.
    stateDir = realpathSync(mkdtempSync("/tmp/lx-shared-"));
    const port = freePort();
    baseUrl = `http://127.0.0.1:${port}`;
    const started = Bun.spawn(["bun", "src/server/index.ts"], {
      cwd: LOXEL_ROOT,
      env: {
        ...process.env,
        LOXEL_DEV: "1",
        LOXEL_STATE_DIR: stateDir,
        LOXEL_SERVE_PORT: String(port),
        SHELL: "/bin/sh",
      },
      stdio: ["ignore", "ignore", "ignore"],
    });
    server = started;
    await eventually(async () => {
      if (started.exitCode !== null) throw new Error(`Server exited: ${started.exitCode}`);
      const response = await fetch(`${baseUrl}/api/version`).catch(() => null);
      return response?.ok ?? false;
    });
    auth = sessionAuthorization(stateDir);
  }, TEST_TIMEOUT_MS);

  afterAll(async () => {
    server?.kill("SIGKILL");
    await server?.exited;
    // Whatever the test left running ends with its host.
    const runDir = hostRunDir(stateDir);
    const entries = existsSync(runDir) ? readdirSync(runDir) : [];
    for (const name of entries.filter((entry) => entry.endsWith(".json"))) {
      const { pid } = JSON.parse(readFileSync(path.join(runDir, name), "utf8")) as { pid: number };
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        // Already gone.
      }
    }
    rmSync(stateDir, { recursive: true, force: true });
  });

  async function runningIds(): Promise<string[]> {
    const response = await fetch(`${baseUrl}/api/terminals`, { headers: auth });
    return RunningTerminalsSchema.parse(await response.json()).terminals.map((t) => t.id);
  }

  /** Two windows attached to a new terminal, `first` before `second`, each synced. */
  async function twoWindows() {
    const id = crypto.randomUUID();
    const first = await openPanel(baseUrl, auth);
    first.attach(id);
    await until(() => first.states.length > 0, TEST_TIMEOUT_MS);
    const second = await openPanel(baseUrl, auth);
    second.attach(id, undefined, { cols: 100, rows: 30 });
    await until(() => second.states.length > 0, TEST_TIMEOUT_MS);
    return { id, first, second };
  }

  /** Type `word` as a command in `panel`, after claiming the terminal as its user's keys do. */
  function run(
    panel: Panel,
    id: string,
    word: string,
    size?: { cols: number; rows: number },
  ): void {
    panel.claim(id, size);
    // Quoted apart, so the echo of the typed line itself never reads as the output.
    panel.type(id, `echo ${word.slice(0, 1)}""${word.slice(1)}`);
  }

  /** What the panel shows: its latest snapshot, then the output after it. */
  const shows = (panel: Panel) => (panel.states.at(-1)?.snapshot ?? "") + panel.text();

  test(
    "every window gets the output, and the one in use types and sets the size",
    async () => {
      const { id, first, second } = await twoWindows();
      // The second window joined without claiming: it renders at the first one's size, which the
      // PTY keeps, and its state says so.
      expect(second.sizes.map(({ cols, rows }) => ({ cols, rows }))).toEqual([
        { cols: 80, rows: 24 },
      ]);
      expect(second.states.at(-1)).toMatchObject({ cols: 80, rows: 24 });

      run(first, id, "from-first");
      await until(() => shows(second).includes("from-first\r\n"), TEST_TIMEOUT_MS);
      await until(() => shows(first).includes("from-first\r\n"), TEST_TIMEOUT_MS);
      expect(first.sizes).toHaveLength(0);
      expect(first.states).toHaveLength(1);

      // Typing in the second window claims it: the first renders at its size.
      run(second, id, "from-second", { cols: 100, rows: 30 });
      await until(() => first.sizes.length > 0, TEST_TIMEOUT_MS);
      expect(first.sizes.map(({ cols, rows }) => ({ cols, rows }))).toEqual([
        { cols: 100, rows: 30 },
      ]);
      await until(() => shows(first).includes("from-second\r\n"), TEST_TIMEOUT_MS);
      await until(() => shows(second).includes("from-second\r\n"), TEST_TIMEOUT_MS);

      // Input from the window not in use (its xterm's replies to queries) is not written.
      first.type(id, 'echo un""claimed');
      run(second, id, "after");
      await until(() => shows(first).includes("after\r\n"), TEST_TIMEOUT_MS);
      expect(shows(first)).not.toContain("unclaimed\r\n");
      first.close();
      second.close();
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a window leaving leaves the others attached, and the last panel closed ends the shell",
    async () => {
      const { id, first, second } = await twoWindows();
      first.close();
      run(second, id, "still-here");
      await until(() => shows(second).includes("still-here\r\n"), TEST_TIMEOUT_MS);

      // Closing the panel in one window keeps the shell for the window still showing it.
      const third = await openPanel(baseUrl, auth);
      third.attach(id);
      await until(() => third.states.length > 0, TEST_TIMEOUT_MS);
      third.detach(id);
      third.destroy(id);
      run(second, id, "kept");
      await until(() => shows(second).includes("kept\r\n"), TEST_TIMEOUT_MS);
      expect(await runningIds()).toContain(id);

      second.detach(id);
      second.destroy(id);
      await eventually(async () => !(await runningIds()).includes(id));
      second.close();
      third.close();
    },
    TEST_TIMEOUT_MS,
  );
});
