/**
 * One pass through every invariant against a real server process, for the wiring in `server.ts`
 * that the in-process suites (`sync-*.test.ts`) mirror rather than run. `LOXEL_DEV=1` keeps the
 * server off the keychain, and a temporary state directory off the user's projects.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { executeAdd, executeMove, executeRemove, setWorktreeMeta } from "@bizimind/wt/lib";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

import type { WorktreeEntry } from "@/api/git-models";
import { encodeInputFrame, type WsMessage } from "@/api/ws-protocol";
import { layoutCanonicalKey, layoutSessionKey } from "@/lib/layout-key-schema";
import {
  CaptureLog,
  createSyncRepo,
  git,
  PROBE_FILE,
  retryUntil,
  type SyncRepo,
} from "@/test/git-sync-harness";
import { until } from "@/test/until";

import { TITLE_KEY } from "./project-worktrees";

// The package's test preload replaces `fetch` and `WebSocket` with browser ones that enforce CORS.
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

describe.each(["bare", "regular"] as const)("real server, %s repo", (layout) => {
  const log = new CaptureLog<WsMessage>();
  let repo: SyncRepo;
  let stateDir: string;
  let server: ReturnType<typeof Bun.spawn>;
  let socket: WebSocket;
  let baseUrl: string;
  let projectId: string;

  const waitFor = <K extends WsMessage["type"]>(
    type: K,
    match: (message: Extract<WsMessage, { type: K }>) => boolean,
    since: number,
  ) =>
    log.waitFor(
      (message) => message.type === type && match(message as Extract<WsMessage, { type: K }>),
      { since, label: `a matching ${type}` },
    );

  async function readJson<T>(url: string): Promise<T> {
    const response = await fetch(`${baseUrl}${url}`);
    if (!response.ok) throw new Error(`GET ${url}: ${response.status}`);
    return (await response.json()) as T;
  }

  const readSidebar = async () =>
    (await readJson<{ worktrees: WorktreeEntry[] }>(`/api/projects/${projectId}/worktrees`))
      .worktrees;

  /**
   * Let everything already done reach the log and return a position after it: `git config` emits
   * only `worktrees`, and a tag only `refs` and `log`.
   */
  async function settle(): Promise<number> {
    let since = log.mark();
    await git(repo.root, "config", "--local", "loxel.sync-settle", String(since));
    await waitFor("worktrees_changed", () => true, since);
    since = log.mark();
    await git(repo.root, "tag", `sync-settle-${since}`);
    await waitFor("log_changed", () => true, since);
    return log.mark();
  }

  /** What a client does: refetch on each `worktrees_changed` until the list satisfies `match`. */
  async function waitForSidebar(match: (list: WorktreeEntry[]) => boolean, since: number) {
    let position = since;
    for (;;) {
      position =
        (await waitFor(
          "worktrees_changed",
          ({ data }) => data.projectPath === repo.root,
          position,
        )) + 1;
      if (match(await readSidebar())) return;
    }
  }

  beforeAll(async () => {
    repo = await createSyncRepo(layout);
    stateDir = realpathSync(mkdtempSync(path.join(tmpdir(), "loxel-sync-state-")));
    const port = freePort();
    baseUrl = `http://127.0.0.1:${port}`;
    server = Bun.spawn(["bun", "src/server/index.ts", repo.root], {
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

    await retryUntil(
      () => {},
      async (timeoutMs) => {
        if (server.exitCode !== null) throw new Error(`Server exited: ${server.exitCode}`);
        if ((await fetch(`${baseUrl}/api/version`).catch(() => null))?.ok) return true;
        await Bun.sleep(timeoutMs);
        return false;
      },
      "the server to listen",
    );
    const { projects } = await readJson<{ projects: Array<{ id: string; path: string }> }>(
      "/api/projects",
    );
    projectId = projects.find((project) => project.path === repo.root)!.id;

    socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    socket.addEventListener("message", (event) => {
      log.add(JSON.parse(String(event.data)) as WsMessage);
    });
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve);
      socket.addEventListener("error", reject);
    });

    socket.send(JSON.stringify({ type: "subscribe_worktree", worktreePath: repo.primary }));
    await waitFor("files_dir_changed", ({ data }) => data.dir === repo.primary, 0);

    // The server gives no signal that its watchers are armed; the first delivered event proves it.
    await retryUntil(
      async (attempt) => {
        await git(repo.root, "config", "--local", "loxel.sync-probe", String(attempt));
      },
      (timeoutMs) =>
        log.seenWithin((message) => message.type === "worktrees_changed", 0, timeoutMs),
      "the project watcher to arm",
    );
    const probe = path.join(repo.primary, PROBE_FILE);
    await retryUntil(
      (attempt) => writeFileSync(probe, String(attempt)),
      (timeoutMs) =>
        log.seenWithin(
          (message) => message.type === "file_content_changed" && message.data.path === probe,
          0,
          timeoutMs,
        ),
      "the file watcher to arm",
    );
    rmSync(probe);
    // Linked worktrees have a status watcher of their own, and a regular root the project's.
    const gitDir = path.resolve(repo.primary, await git(repo.primary, "rev-parse", "--git-dir"));
    const lock = path.join(gitDir, "index.lock");
    const beforeLock = log.mark();
    await retryUntil(
      () => {
        writeFileSync(lock, "");
        rmSync(lock);
      },
      (timeoutMs) =>
        log.seenWithin((message) => message.type === "status_changed", beforeLock, timeoutMs),
      "the status watcher to arm",
    );
  }, TEST_TIMEOUT_MS);

  afterAll(async () => {
    socket?.close();
    server?.kill();
    await server?.exited;
    if (stateDir) rmSync(stateDir, { recursive: true, force: true });
    repo?.cleanup();
  });

  test(
    "worktrees follow wt add, metadata and remove",
    async () => {
      let since = log.mark();
      const { path: child } = await executeAdd({ name: "smoke-child", repoPath: repo.root });
      await waitForSidebar((list) => list.some((wt) => wt.path === child), since);

      since = await settle();
      await setWorktreeMeta({
        repoPath: repo.root,
        name: "smoke-child",
        values: { [TITLE_KEY]: "Smoke" },
      });
      await waitForSidebar((list) => list.some((wt) => wt.title === "Smoke"), since);

      // Removing a worktree a client has open also releases its resources.
      socket.send(JSON.stringify({ type: "subscribe_worktree", worktreePath: child }));
      await waitFor("files_dir_changed", ({ data }) => data.dir === child, since);

      since = log.mark();
      await executeRemove({
        name: "smoke-child",
        repoPath: repo.root,
        deleteBranch: true,
        force: true,
      });
      await waitForSidebar((list) => !list.some((wt) => wt.path === child), since);

      // Resources still held would make this subscribe return early, with no listing.
      since = log.mark();
      await executeAdd({ name: "smoke-child", repoPath: repo.root });
      socket.send(JSON.stringify({ type: "subscribe_worktree", worktreePath: child }));
      await waitFor("files_dir_changed", ({ data }) => data.dir === child, since);
    },
    TEST_TIMEOUT_MS,
  );

  describe("a removed worktree's terminals and rows", () => {
    const WINDOW_ID = "11111111-2222-3333-4444-555555555555";
    let wtBinDir: string;

    const storeUrl = (key: string) => `${baseUrl}/api/stores/${encodeURIComponent(key)}`;
    const putRow = (key: string, value = "{}") =>
      fetch(storeUrl(key), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value }),
      });
    const readRow = async (key: string) =>
      (await readJson<{ value: string | null }>(`/api/stores/${encodeURIComponent(key)}`)).value;
    const rowsOf = (wtPath: string) => [
      layoutSessionKey(WINDOW_ID, "center", wtPath),
      layoutCanonicalKey("center", wtPath),
      layoutCanonicalKey("outer", wtPath),
      `external-folders:${wtPath}`,
      `python-interpreter:${wtPath}`,
    ];
    const seedRows = (wtPath: string) => Promise.all(rowsOf(wtPath).map((key) => putRow(key)));
    const readRows = (wtPath: string) => Promise.all(rowsOf(wtPath).map(readRow));

    /** A terminal in `wtPath`, on a socket of its own, with its shell's PID. */
    async function openTerminal(wtPath: string, id: string = crypto.randomUUID()) {
      const states: Array<{ epoch: string }> = [];
      const output: string[] = [];
      const terminal = new WebSocket(baseUrl.replace("http", "ws") + "/ws");
      terminal.binaryType = "arraybuffer";
      terminal.addEventListener("message", (event) => {
        if (typeof event.data !== "string") {
          output.push(new TextDecoder().decode(event.data as ArrayBuffer));
          return;
        }
        const message = JSON.parse(event.data) as WsMessage;
        if (message.type === "terminal_state") states.push(message);
      });
      await new Promise((resolve, reject) => {
        terminal.addEventListener("open", resolve);
        terminal.addEventListener("error", reject);
      });
      terminal.send(
        JSON.stringify({
          type: "terminal_attach",
          id,
          cols: 80,
          rows: 24,
          cwd: wtPath,
          worktreePath: wtPath,
        }),
      );
      await until(() => states.length > 0, TEST_TIMEOUT_MS);
      const type = (command: string) =>
        terminal.send(
          new Uint8Array(encodeInputFrame(id, new TextEncoder().encode(`${command}\n`))),
        );
      const pidFile = path.join(stateDir, `shell-${id}.pid`);
      type(`echo $$ > "${pidFile}"`);
      await until(
        () => existsSync(pidFile) && readFileSync(pidFile, "utf8").endsWith("\n"),
        TEST_TIMEOUT_MS,
      );
      return {
        id,
        epoch: states[0]!.epoch,
        output,
        pid: Number(readFileSync(pidFile, "utf8")),
        type,
        close: () => terminal.close(),
      };
    }

    const isAlive = (pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    const untilDead = (pid: number) => until(() => !isAlive(pid), TEST_TIMEOUT_MS);

    beforeAll(async () => {
      wtBinDir = mkdtempSync(path.join(tmpdir(), "loxel-wt-bin-"));
      const built = Bun.spawnSync(
        ["bun", "build", "--compile", "src/cli.ts", "--outfile", path.join(wtBinDir, "wt")],
        { cwd: path.resolve(LOXEL_ROOT, "../wt"), stdout: "ignore", stderr: "pipe" },
      );
      if (built.exitCode !== 0) throw new Error(built.stderr.toString());
    }, TEST_TIMEOUT_MS);

    afterAll(() => {
      if (wtBinDir) rmSync(wtBinDir, { recursive: true, force: true });
    });

    test(
      "wt remove ends its terminals and deletes its rows, and a new worktree there starts fresh",
      async () => {
        const name = "rm-outside";
        const { path: wtPath } = await executeAdd({ name, repoPath: repo.root });
        await settle();
        await seedRows(wtPath);
        const terminal = await openTerminal(wtPath);
        const bystander = await openTerminal(repo.primary);

        await executeRemove({ name, repoPath: repo.root, deleteBranch: true, force: true });
        await untilDead(terminal.pid);

        expect(isAlive(bystander.pid)).toBe(true);
        expect(await readRows(wtPath)).toEqual(rowsOf(wtPath).map(() => null));

        // A window still showing it saves its layout on the way out; that must not bring it back.
        await putRow(layoutSessionKey(WINDOW_ID, "center", wtPath));
        expect(await readRow(layoutSessionKey(WINDOW_ID, "center", wtPath))).toBeNull();

        await executeAdd({ name, repoPath: repo.root });
        await putRow(layoutSessionKey(WINDOW_ID, "center", wtPath));
        expect(await readRow(layoutSessionKey(WINDOW_ID, "center", wtPath))).toBe("{}");
        // The old panel's ID, if anything still had it, gets a new shell rather than the old one.
        const again = await openTerminal(wtPath, terminal.id);
        expect(again.epoch).not.toBe(terminal.epoch);

        await executeRemove({ name, repoPath: repo.root, deleteBranch: true, force: true });
        await untilDead(again.pid);
        terminal.close();
        again.close();
        bystander.close();
      },
      TEST_TIMEOUT_MS,
    );

    test(
      "wt rm from inside the worktree's own terminal finishes before that terminal ends",
      async () => {
        const name = "rm-from-inside";
        const { path: wtPath } = await executeAdd({ name, repoPath: repo.root });
        await settle();
        const terminal = await openTerminal(wtPath);
        const done = path.join(stateDir, `${name}.done`);

        terminal.type(
          `"${wtBinDir}/wt" rm --force --delete-branch ${name} --json; echo $? > "${done}"`,
        );
        await untilDead(terminal.pid);

        expect(readFileSync(done, "utf8").trim()).toBe("0");
        expect(await git(repo.root, "branch", "--list", name)).toBe("");
        expect(existsSync(wtPath)).toBe(false);
        const worktreesDir = (
          await readJson<{ projects: Array<{ path: string; worktreesDir: string }> }>(
            "/api/projects",
          )
        ).projects.find((p) => p.path === repo.root)!.worktreesDir;
        const parked = () =>
          readdirSync(path.join(worktreesDir, ".wt-trash")).filter((entry) =>
            entry.startsWith(name),
          );
        await until(() => parked().length === 0, TEST_TIMEOUT_MS);
        terminal.close();
      },
      TEST_TIMEOUT_MS,
    );

    test(
      "wt mv and other worktree events keep the terminals and rows, and removal then ends them",
      async () => {
        const { path: from } = await executeAdd({ name: "mv-before", repoPath: repo.root });
        await settle();
        await seedRows(from);
        const terminal = await openTerminal(from);

        await setWorktreeMeta({
          repoPath: repo.root,
          name: "mv-before",
          values: { [TITLE_KEY]: "T" },
        });
        const { path: to } = await executeMove({
          oldName: "mv-before",
          name: "mv-after",
          repoPath: repo.root,
        });
        await settle();
        await settle();

        // Rows go in the same step as the terminals, with no delay: this shows that step never ran.
        expect(await readRows(from)).toEqual(rowsOf(from).map(() => "{}"));
        expect(isAlive(terminal.pid)).toBe(true);

        await executeRemove({
          name: "mv-after",
          repoPath: repo.root,
          deleteBranch: true,
          force: true,
        });
        await untilDead(terminal.pid);
        expect(existsSync(to)).toBe(false);
        terminal.close();
      },
      TEST_TIMEOUT_MS,
    );

    test(
      "an in-app removal waits for the clean hook, and a failed one changes nothing",
      async () => {
        const name = "rm-in-app";
        const { path: wtPath } = await executeAdd({ name, repoPath: repo.root });
        await settle();
        await seedRows(wtPath);
        writeFileSync(path.join(wtPath, "dirty.txt"), "uncommitted\n");
        const terminal = await openTerminal(wtPath);

        const remove = (force: boolean) =>
          fetch(`${baseUrl}/api/worktree/remove`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              projectPath: repo.root,
              path: wtPath,
              deleteBranch: true,
              force,
            }),
          });

        expect((await remove(false)).ok).toBe(false);
        await settle();
        await settle();
        expect(existsSync(wtPath)).toBe(true);
        expect(await readRows(wtPath)).toEqual(rowsOf(wtPath).map(() => "{}"));
        expect(isAlive(terminal.pid)).toBe(true);

        // The hook waits for this test, so the shell must still be running while it does.
        const hook = path.join(repo.root, "clean.wt.sh");
        const hookStarted = path.join(stateDir, `${name}.hook-started`);
        const hookRelease = path.join(stateDir, `${name}.hook-release`);
        writeFileSync(
          hook,
          `touch "${hookStarted}"\nwhile [ ! -e "${hookRelease}" ]; do sleep 0.05; done\n`,
        );
        try {
          const removal = remove(true);
          await until(() => existsSync(hookStarted), TEST_TIMEOUT_MS);
          expect(isAlive(terminal.pid)).toBe(true);
          expect(await readRow(rowsOf(wtPath)[0]!)).toBe("{}");

          writeFileSync(hookRelease, "");
          expect((await removal).ok).toBe(true);
          await untilDead(terminal.pid);
          expect(await readRows(wtPath)).toEqual(rowsOf(wtPath).map(() => null));
        } finally {
          rmSync(hook, { force: true });
          terminal.close();
        }
      },
      TEST_TIMEOUT_MS,
    );
  });

  test(
    "the changes panel and explorer follow an edit, a stage and a commit",
    async () => {
      const name = "smoke-file.txt";
      let since = log.mark();
      await Bun.write(path.join(repo.primary, name), "x\n");
      await Promise.all([
        waitFor("status_changed", ({ data }) => data.untracked.includes(name), since),
        waitFor(
          "files_dir_changed",
          ({ data }) =>
            data.dir === repo.primary &&
            data.entries.some((entry) => entry.name === name && entry.status === "untracked"),
          since,
        ),
      ]);

      since = log.mark();
      await git(repo.primary, "add", name);
      await waitFor(
        "status_changed",
        ({ data }) => data.staged.some((file) => file.path === name),
        since,
      );

      since = log.mark();
      await git(repo.primary, "commit", "-q", "-m", "smoke");
      const sha = await git(repo.primary, "rev-parse", "HEAD");
      await waitFor("status_changed", ({ data }) => data.commit === sha, since);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "the commit graph and another worktree's entry follow a commit there",
    async () => {
      const { path: other } = await executeAdd({ name: "smoke-other", repoPath: repo.root });
      await Bun.write(path.join(other, "committed.txt"), "x\n");
      await Bun.write(path.join(other, "still-dirty.txt"), "x\n");

      const since = await settle();
      await git(other, "add", "committed.txt");
      await git(other, "commit", "-q", "-m", "elsewhere", "--", "committed.txt");
      const sha = await git(other, "rev-parse", "HEAD");

      await Promise.all([
        waitFor("log_changed", ({ projectPath }) => projectPath === repo.root, since),
        waitFor("refs_changed", ({ projectPath }) => projectPath === repo.root, since),
        waitFor(
          "worktree_status_changed",
          ({ data }) => data.some((entry) => entry.path === other && entry.commit === sha),
          since,
        ),
      ]);
      const { commits } = await readJson<{ commits: Array<{ hash: string }> }>(
        `/api/graph?project=${encodeURIComponent(repo.root)}&all=true`,
      );
      expect(commits.map((commit) => commit.hash)).toContain(sha);
    },
    TEST_TIMEOUT_MS,
  );
});
