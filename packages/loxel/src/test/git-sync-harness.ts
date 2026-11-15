/**
 * Real temporary git repositories wired to the real watchers, for tests that lock how Loxel follows
 * worktree, working-tree and history changes. {@link SyncProject} connects `FileWatcher`,
 * `ProjectFilesService` and `WorktreeStatusTracker` the way `initializeProject` and
 * `subscribeWorktree` in `server/server.ts` do, and captures what they would broadcast;
 * `server/sync-server-smoke.test.ts` covers the real server's wiring.
 *
 * Nothing here waits on time. A test awaits the captured event it expects ({@link CaptureLog.waitFor}),
 * and asserts that an event is absent by running a later operation known to emit
 * ({@link SyncProject.sentinel}) and looking at what arrived before it. The only timeouts are
 * deadlines that fail a test, and the per-attempt wait of {@link retryUntil}, which can make arming
 * slower but cannot make a test fail.
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { cloneBareRepo, executeInit, type InitActionId } from "@bizimind/wt/lib";

import type { StatusInfo, WorktreeEntry } from "@/api/git-models";
import type { WsMessage } from "@/api/ws-protocol";
import { FileWatcher, type WatchEvent } from "@/server/file-watcher";
import { getLog, getRefs } from "@/server/git-commands";
import { ProjectFilesService } from "@/server/project-files-service";
import { projectWorktreesResponse } from "@/server/project-worktrees";
import { WorktreeStatusTracker } from "@/server/worktree-status-tracker";

/** How long an expected event may take before the test fails. Generous for a loaded machine. */
const EVENT_DEADLINE_MS = 30_000;
/** How long one attempt of {@link retryUntil} waits for its signal before repeating the action. */
const RETRY_ATTEMPT_MS = 250;
/** The server's debounce for git-directory events. */
const WATCHER_DEBOUNCE_MS = 150;
/** File the arming probe writes in a working tree; ignored through `info/exclude`. */
export const PROBE_FILE = ".sync-probe";

// --- Plain git, as a terminal would run it ---

/** A shell's environment for git: no `GIT_OPTIONAL_LOCKS`, and no config from this machine. */
function shellGitEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
  };
  // Set when the tests run from inside a git hook; they would redirect every command.
  for (const name of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OPTIONAL_LOCKS"]) {
    delete env[name];
  }
  return env;
}

/** Run git in `cwd` with a shell's environment, throwing with stderr on failure. */
export async function git(cwd: string, ...args: string[]): Promise<string> {
  const proc = Bun.spawn(["git", "-C", cwd, ...args], {
    env: shellGitEnv(),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${stderr}`);
  return stdout.trim();
}

// --- Event capture ---

interface LogWaiter<T> {
  match: (entry: T) => boolean;
  resolve: (seq: number) => void;
  since: number;
}

/** An ordered list of captured events that tests can await and slice. */
export class CaptureLog<T> {
  readonly entries: T[] = [];
  private waiters: Array<LogWaiter<T>> = [];

  add(entry: T): void {
    const seq = this.entries.length;
    this.entries.push(entry);
    this.waiters = this.waiters.filter((waiter) => {
      if (seq < waiter.since || !waiter.match(entry)) return true;
      waiter.resolve(seq);
      return false;
    });
  }

  /** A position to pass as `since`; what is captured from now on comes at or after it. */
  mark(): number {
    return this.entries.length;
  }

  /** The entries captured from `since`, up to but not including `until`. */
  slice(since: number, until = this.entries.length): T[] {
    return this.entries.slice(since, until);
  }

  /** The position of the first entry from `since` that matches, or null after `timeoutMs`. */
  private find(match: (entry: T) => boolean, since: number, timeoutMs: number) {
    for (let seq = since; seq < this.entries.length; seq++) {
      if (match(this.entries[seq]!)) return Promise.resolve<number | null>(seq);
    }
    return new Promise<number | null>((resolve) => {
      const waiter: LogWaiter<T> = {
        match,
        since,
        resolve: (seq) => {
          clearTimeout(timer);
          resolve(seq);
        },
      };
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((other) => other !== waiter);
        resolve(null);
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  /** Wait for the first entry from `since` that matches and return its position. */
  async waitFor(
    match: (entry: T) => boolean,
    { since = 0, label = "event" }: { since?: number; label?: string } = {},
  ): Promise<number> {
    const seq = await this.find(match, since, EVENT_DEADLINE_MS);
    if (seq !== null) return seq;
    throw new Error(
      `Timed out waiting for ${label}; captured: ${JSON.stringify(this.slice(since)).slice(-2000)}`,
    );
  }

  /** Whether a matching entry arrives from `since` within `timeoutMs`; never throws. */
  async seenWithin(match: (entry: T) => boolean, since: number, timeoutMs: number) {
    return (await this.find(match, since, timeoutMs)) !== null;
  }
}

/**
 * Repeat `action` until `seen` resolves true, for a watcher that cannot say when it is ready: a
 * native watch misses what happens before it arms, and nothing signals that it has. The first
 * delivered event proves it live.
 */
export async function retryUntil(
  action: (attempt: number) => void | Promise<void>,
  seen: (timeoutMs: number) => Promise<boolean>,
  label: string,
): Promise<void> {
  const deadline = Date.now() + EVENT_DEADLINE_MS;
  for (let attempt = 0; Date.now() < deadline; attempt++) {
    await action(attempt);
    if (await seen(RETRY_ATTEMPT_MS)) return;
  }
  throw new Error(`Timed out waiting for ${label}`);
}

// --- Repositories ---

export type RepoLayout = "bare" | "regular";

export interface SyncRepo {
  layout: RepoLayout;
  /** The temporary directory holding this repo and its remote; a place for more clones. */
  base: string;
  /** The project path: the bare repo's root, or the regular repo's root checkout. */
  root: string;
  /** The worktree a client has open first: `.worktrees/main` in a bare repo, else the root. */
  primary: string;
  /** The bare repo `root` has as `origin`. */
  remote: string;
  /** The main-branch commit every clone starts from. */
  initialCommit: string;
  cleanup(): void;
}

/** What `wt init --worktree-metadata on` applies. */
const METADATA_ON: InitActionId[] = ["worktree-metadata-on"];

/**
 * A repo with one pushed commit on `main` (`a.txt`, `sub/b.txt`), an `origin`, and worktree metadata
 * on, in the layout `wt init` gives it.
 */
export async function createSyncRepo(layout: RepoLayout): Promise<SyncRepo> {
  const base = realpathSync(await mkdtemp(path.join(tmpdir(), "loxel-sync-")));
  const seed = path.join(base, "seed");
  mkdirSync(path.join(seed, "sub"), { recursive: true });
  await git(base, "init", "-q", "-b", "main", seed);
  await configureIdentity(seed);
  writeFileSync(path.join(seed, "a.txt"), "one\n");
  writeFileSync(path.join(seed, "sub", "b.txt"), "b\n");
  await git(seed, "add", "-A");
  await git(seed, "commit", "-q", "-m", "init");
  const initialCommit = await git(seed, "rev-parse", "HEAD");

  const remote = path.join(base, "remote.git");
  await git(base, "clone", "-q", "--bare", seed, remote);

  const root = path.join(base, "project");
  if (layout === "bare") await cloneBareRepo({ url: remote, cwd: base, dir: "project" });
  else await git(base, "clone", "-q", remote, root);
  await executeInit(root, { apply: METADATA_ON });
  await configureIdentity(root);
  // Excluded rather than ignored in `.gitignore`: tests assert on what `.gitignore` changes do.
  const commonDir = path.resolve(root, await git(root, "rev-parse", "--git-common-dir"));
  mkdirSync(path.join(commonDir, "info"), { recursive: true });
  appendFileSync(path.join(commonDir, "info", "exclude"), `${PROBE_FILE}\n`);

  return {
    layout,
    base,
    root,
    primary: layout === "bare" ? path.join(root, ".worktrees", "main") : root,
    remote,
    initialCommit,
    // Removing a worktree leaves a detached `rm -rf` running, which this can race with.
    cleanup: () => rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }),
  };
}

async function configureIdentity(repo: string): Promise<void> {
  await git(repo, "config", "user.email", "sync@example.com");
  await git(repo, "config", "user.name", "Sync Test");
}

// --- The server's wiring ---

export type SyncEvent =
  /** A `FileWatcher` emitted, from the project's watcher or a worktree's status-only one. */
  | { kind: "watch"; source: "project" | "worktree"; wtPath?: string; event: WatchEvent }
  /** A message the server would send to clients. */
  | { kind: "broadcast"; message: WsMessage }
  /** The worktree list a client got by refetching it after a `worktrees_changed`. */
  | { kind: "sidebar"; startedAt: number; worktrees: WorktreeEntry[] }
  /** The commit graph a client got by refetching it after a `refs_changed` or `log_changed`. */
  | { kind: "graph"; startedAt: number; graph: GraphRead };

/**
 * The commit graph's content: commits as `GET /api/graph` reads them, refs as git reports them.
 * Refs do not go through `getRefs`, whose cache has its own test in `sync-git-history.test.ts`.
 */
export interface GraphRead {
  shas: string[];
  /** Full ref name → object name. */
  refs: Map<string, string>;
}

type MessageOf<K extends WsMessage["type"]> = Extract<WsMessage, { type: K }>;

interface SubscribedWorktree {
  watcher: FileWatcher | null;
  files: ProjectFilesService;
}

export interface SentinelOptions {
  /**
   * How to emit: `git config` emits `worktrees` only, and a new tag `refs` and `log` only. Use
   * `config` to assert the absence of status, refs or log events, and `ref` to assert the absence
   * of worktrees events.
   */
  via: "config" | "ref";
}

/** One project, wired like `initializeProject`, with the worktrees a client has subscribed to. */
export class SyncProject {
  readonly log = new CaptureLog<SyncEvent>();
  readonly tracker: WorktreeStatusTracker;
  readonly worktrees = new Map<string, SubscribedWorktree>();

  private readonly watcher: FileWatcher;
  private probes = 0;
  private stopped = false;

  private constructor(
    readonly cwd: string,
    readonly isBare: boolean,
  ) {
    this.tracker = new WorktreeStatusTracker({
      projectPath: cwd,
      liveStatus: (wtPath) => this.worktrees.get(wtPath)?.files.getStatusSnapshot() ?? undefined,
      hasListeners: () => this.worktrees.size > 0,
      onChange: (statuses) =>
        this.broadcast({ type: "worktree_status_changed", projectPath: cwd, data: statuses }),
    });
    this.watcher = new FileWatcher({
      gitRoot: cwd,
      debounceMs: WATCHER_DEBOUNCE_MS,
      allowedEvents: isBare ? new Set(["refs", "log", "worktrees"]) : undefined,
      onEvent: (event) => this.onProjectEvent(event),
    });
  }

  /** Start the project's watcher and wait until it delivers events. */
  static async open(repo: SyncRepo): Promise<SyncProject> {
    const project = new SyncProject(repo.root, repo.layout === "bare");
    await project.watcher.start();
    try {
      await project.armProjectWatcher();
    } catch (error) {
      // The caller has no project to stop, and its repository is about to be deleted.
      project.stop();
      throw error;
    }
    return project;
  }

  private async onProjectEvent(event: WatchEvent): Promise<void> {
    if (this.stopped) return;
    this.log.add({ kind: "watch", source: "project", event });
    if (event === "worktrees") {
      this.broadcast({ type: "worktrees_changed", data: { projectPath: this.cwd } });
      for (const wtPath of [...this.worktrees.keys()]) {
        if (!existsSync(wtPath)) this.unsubscribe(wtPath);
      }
      this.tracker.invalidate();
    } else if (event === "status") {
      for (const { files } of this.worktrees.values()) void files.refreshGitStatus();
    } else if (event === "refs") {
      // Nothing awaits this handler, and a read still running when a test ends finds no repository.
      const refs = await getRefs(this.cwd).catch((error: unknown) => {
        if (!this.stopped) throw error;
        return null;
      });
      if (refs && !this.stopped) {
        this.broadcast({ type: "refs_changed", projectPath: this.cwd, data: refs });
      }
    } else {
      this.broadcast({ type: "log_changed", projectPath: this.cwd });
      this.tracker.invalidate();
    }
  }

  /** Capture a message, and the refetch a client does on receiving it. */
  private broadcast(message: WsMessage): void {
    this.log.add({ kind: "broadcast", message });
    const startedAt = this.log.mark();
    if (message.type === "worktrees_changed") {
      void this.clientRefetch(async () => ({
        kind: "sidebar",
        startedAt,
        worktrees: await this.readSidebar(),
      }));
    } else if (message.type === "refs_changed" || message.type === "log_changed") {
      void this.clientRefetch(async () => ({
        kind: "graph",
        startedAt,
        graph: await this.readGraph(),
      }));
    }
  }

  /** Refetches overlap, so each entry says where it started: a slow one can land out of order. */
  private async clientRefetch(read: () => Promise<SyncEvent>): Promise<void> {
    try {
      const entry = await read();
      if (!this.stopped) this.log.add(entry);
    } catch (error) {
      // A refetch still running when a test ends finds its repository deleted.
      if (!this.stopped) throw error;
    }
  }

  /** What `subscribeWorktree` sets up for a client's first subscriber; waits until it is live. */
  async subscribe(wtPath: string): Promise<void> {
    if (this.worktrees.has(wtPath)) return;

    let watcher: FileWatcher | null = null;
    if (wtPath !== this.cwd) {
      watcher = new FileWatcher({
        gitRoot: wtPath,
        debounceMs: WATCHER_DEBOUNCE_MS,
        allowedEvents: new Set(["status"]),
        onEvent: (event) => {
          this.log.add({ kind: "watch", source: "worktree", wtPath, event });
          void this.worktrees.get(wtPath)?.files.refreshGitStatus();
        },
      });
      await watcher.start();
    }
    const files = new ProjectFilesService(
      wtPath,
      (dir, entries) =>
        this.broadcast({ type: "files_dir_changed", wtPath, data: { dir, entries } }),
      (filePath, nonces) =>
        this.broadcast({ type: "file_content_changed", wtPath, data: { path: filePath, nonces } }),
      (status: StatusInfo) => {
        if (this.worktrees.get(wtPath)?.files !== files) return;
        this.broadcast({ type: "status_changed", wtPath, data: status });
        this.tracker.update(wtPath, status);
      },
      {
        onFileMoved: (oldPath, newPath, source) =>
          this.broadcast({ type: "file_moved", wtPath, data: { oldPath, newPath, source } }),
      },
    );
    await files.start();
    this.worktrees.set(wtPath, { watcher, files });
    this.tracker.invalidate();
    const entries = await files.getDirContents("", wtPath);
    this.broadcast({ type: "files_dir_changed", wtPath, data: { dir: wtPath, entries } });
    await this.armWorktree(wtPath, watcher !== null);
  }

  /** Stop a worktree's resources, as `teardownWorktreeResources` does for the last unsubscribe. */
  unsubscribe(wtPath: string): void {
    const resources = this.worktrees.get(wtPath);
    resources?.watcher?.stop();
    resources?.files.stop();
    this.worktrees.delete(wtPath);
  }

  stop(): void {
    this.stopped = true;
    this.tracker.dispose();
    this.watcher.stop();
    for (const wtPath of [...this.worktrees.keys()]) this.unsubscribe(wtPath);
  }

  // --- Arming ---

  private async armProjectWatcher(): Promise<void> {
    await this.retryAction(
      () => this.setProbeConfig(),
      (entry) => isWatch(entry, "project", "worktrees"),
      "the project watcher to arm",
    );
  }

  /** A status watch reports `index.lock`, and the file watch reports the probe file. */
  private async armWorktree(wtPath: string, hasOwnWatcher: boolean): Promise<void> {
    const gitDir = path.resolve(wtPath, await git(wtPath, "rev-parse", "--git-dir"));
    const lock = path.join(gitDir, "index.lock");
    if (hasOwnWatcher) {
      await this.retryAction(
        () => {
          writeFileSync(lock, "");
          rmSync(lock);
        },
        (entry) =>
          entry.kind === "watch" &&
          entry.source === "worktree" &&
          entry.wtPath === wtPath &&
          entry.event === "status",
        `the status watcher of ${wtPath} to arm`,
      );
    }
    const probe = path.join(wtPath, PROBE_FILE);
    await this.retryAction(
      (attempt) => writeFileSync(probe, String(attempt)),
      (entry) =>
        entry.kind === "broadcast" &&
        entry.message.type === "file_content_changed" &&
        entry.message.data.path === probe,
      `the file watcher of ${wtPath} to arm`,
    );
    rmSync(probe);
  }

  private async retryAction(
    action: (attempt: number) => void | Promise<void>,
    match: (entry: SyncEvent) => boolean,
    label: string,
  ): Promise<void> {
    const since = this.log.mark();
    await retryUntil(action, (ms) => this.log.seenWithin(match, since, ms), label);
  }

  private async setProbeConfig(): Promise<void> {
    await git(this.cwd, "config", "--local", "loxel.sync-probe", String(++this.probes));
  }

  // --- Waiting and asserting ---

  /** Wait for the first `type` message from `since` that matches, and return it. */
  async waitForMessage<K extends WsMessage["type"]>(
    type: K,
    match: (message: MessageOf<K>) => boolean = () => true,
    since = 0,
  ): Promise<MessageOf<K>> {
    const seq = await this.log.waitFor(
      (entry) =>
        entry.kind === "broadcast" &&
        entry.message.type === type &&
        match(entry.message as MessageOf<K>),
      { since, label: `a matching ${type}` },
    );
    return (this.log.entries[seq] as Extract<SyncEvent, { kind: "broadcast" }>)
      .message as MessageOf<K>;
  }

  /** Wait for a `status_changed` of `wtPath` whose status satisfies `match`. */
  waitForStatus(wtPath: string, match: (status: StatusInfo) => boolean, since = 0) {
    return this.waitForMessage(
      "status_changed",
      (message) => message.wtPath === wtPath && match(message.data),
      since,
    );
  }

  /**
   * Run an operation known to emit, wait for its event, and return the event's position. Every
   * event caused by anything before the operation comes earlier, since watcher events are delivered
   * in order and debounced alike, provided that the earlier operations did not emit what the
   * sentinel waits for. Commits emit what a ref sentinel waits for, so it tags twice: the first
   * tag's event may be taken for theirs, but the second tag's cannot come before the first's.
   */
  async sentinel({ via }: SentinelOptions): Promise<number> {
    if (via === "config") {
      const since = this.log.mark();
      await this.setProbeConfig();
      return this.log.waitFor((entry) => isWatch(entry, "project", "worktrees"), {
        since,
        label: "the config sentinel",
      });
    }
    let seq = -1;
    for (let tag = 0; tag < 2; tag++) {
      const since = this.log.mark();
      await git(this.cwd, "tag", `sync-sentinel-${++this.probes}`);
      seq = await this.log.waitFor((entry) => isWatch(entry, "project", "log"), {
        since,
        label: "the ref sentinel",
      });
    }
    return seq;
  }

  /**
   * Let everything already done reach the log, and return a position after it: the base of a
   * negative assertion, which earlier operations' watcher events cannot leak past.
   */
  async settle(): Promise<number> {
    await this.sentinel({ via: "config" });
    await this.sentinel({ via: "ref" });
    return this.log.mark();
  }

  /** The watcher events captured between two positions. */
  watchEvents(since: number, until?: number): Array<Extract<SyncEvent, { kind: "watch" }>> {
    return this.log
      .slice(since, until)
      .filter((entry): entry is Extract<SyncEvent, { kind: "watch" }> => entry.kind === "watch");
  }

  /** Wait until a client's refetch after `worktrees_changed` shows a list satisfying `match`. */
  async waitForSidebar(match: (worktrees: WorktreeEntry[]) => boolean, since = 0) {
    const seq = await this.log.waitFor(
      (entry) => entry.kind === "sidebar" && entry.startedAt >= since && match(entry.worktrees),
      { since, label: "a matching worktree list" },
    );
    return (this.log.entries[seq] as Extract<SyncEvent, { kind: "sidebar" }>).worktrees;
  }

  /** Wait until a client's refetch after a ref or log event shows a graph satisfying `match`. */
  async waitForGraph(match: (graph: GraphRead) => boolean, since = 0) {
    const seq = await this.log.waitFor(
      (entry) => entry.kind === "graph" && entry.startedAt >= since && match(entry.graph),
      { since, label: "a matching commit graph" },
    );
    return (this.log.entries[seq] as Extract<SyncEvent, { kind: "graph" }>).graph;
  }

  private async readSidebar(): Promise<WorktreeEntry[]> {
    return (await projectWorktreesResponse(this.cwd)).worktrees;
  }

  private async readGraph(): Promise<GraphRead> {
    const [commits, refs] = await Promise.all([
      getLog(this.cwd, { all: true, limit: 200 }),
      git(this.cwd, "for-each-ref", "--format=%(refname) %(objectname)"),
    ]);
    return {
      shas: commits.map((commit) => commit.hash),
      refs: new Map(refs.split("\n").map((line) => line.split(" ") as [string, string])),
    };
  }
}

function isWatch(entry: SyncEvent, source: "project" | "worktree", event: WatchEvent): boolean {
  return entry.kind === "watch" && entry.source === source && entry.event === event;
}
