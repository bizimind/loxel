/**
 * One pass through every invariant against a real server process, for the wiring in `server.ts`
 * that the in-process suites (`sync-*.test.ts`) mirror rather than run. `LOXEL_DEV=1` keeps the
 * server off the keychain, and a temporary state directory off the user's projects.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { executeAdd, executeRemove, setWorktreeMeta } from "@bizimind/wt/lib";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

import type { WorktreeEntry } from "@/api/git-models";
import type { WsMessage } from "@/api/ws-protocol";
import {
  CaptureLog,
  createSyncRepo,
  git,
  PROBE_FILE,
  retryUntil,
  type SyncRepo,
} from "@/test/git-sync-harness";

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
