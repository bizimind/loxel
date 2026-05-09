import { realpathSync, watch, type FSWatcher } from "node:fs";
import path from "node:path";

import { logger } from "./logger";
import { stress } from "./stress-detector";

const log = logger.child("watcher");

export type WatchEvent = "status" | "refs" | "log" | "worktrees";

export interface FileWatcherOptions {
  gitRoot: string;
  onEvent: (event: WatchEvent) => void;
  debounceMs?: number;
  /** If set, only emit these event types (filters out the rest). */
  allowedEvents?: Set<WatchEvent>;
}

/**
 * Resolve the actual git directories to watch.
 *
 * In a regular repo: --git-dir and --git-common-dir both resolve to `.git/`.
 * In a worktree: --git-dir is the worktree-specific dir (HEAD, index),
 * --git-common-dir is the shared dir (objects, refs/heads, refs/tags).
 * We need to watch both for full coverage.
 */
async function resolveGitDirs(gitRoot: string): Promise<{ gitDir: string; commonDir: string }> {
  const [gitDirRaw, commonDirRaw] = await Promise.all([
    Bun.$`git -C ${gitRoot} rev-parse --git-dir`.text(),
    Bun.$`git -C ${gitRoot} rev-parse --git-common-dir`.text(),
  ]);

  const resolve = (raw: string) => {
    const trimmed = raw.trim();
    const absolute = trimmed.startsWith("/") ? trimmed : path.join(gitRoot, trimmed);
    return realpathSync(absolute);
  };

  return { gitDir: resolve(gitDirRaw), commonDir: resolve(commonDirRaw) };
}

export function classifyGitChange(filename: string): WatchEvent[] {
  if (filename.endsWith(".lock")) return [];

  const events: WatchEvent[] = [];

  if (filename === "index") {
    events.push("status");
  }

  if (filename === "HEAD" || filename === "ORIG_HEAD") {
    events.push("refs", "log");
  }

  if (filename.startsWith("refs/")) {
    events.push("refs");
    if (filename.startsWith("refs/heads/") || filename.startsWith("refs/tags/")) {
      events.push("log");
    }
  }

  if (filename === "packed-refs") {
    events.push("refs");
  }

  if (filename.endsWith("_HEAD") && filename !== "HEAD") {
    events.push("status", "refs");
  }

  if (filename === "refs/stash" || filename.startsWith("logs/refs/stash")) {
    events.push("status");
  }

  if (filename.startsWith("worktrees/") && filename.endsWith("/gitdir")) {
    events.push("worktrees");
  }

  return events;
}

/**
 * Watch the git directory (and common dir for worktrees) for changes and emit events.
 *
 * Uses Node's native fs.watch with `{ recursive: true }` which leverages macOS FSEvents
 * for zero-overhead recursive watching (no initial directory scan).
 */
export class FileWatcher {
  private watchers: FSWatcher[] = [];
  private gitRoot: string;
  private onEvent: (event: WatchEvent) => void;
  private debounceMs: number;
  private allowedEvents: Set<WatchEvent> | null;
  private debounceTimers: Map<WatchEvent, ReturnType<typeof setTimeout>> = new Map();

  constructor(options: FileWatcherOptions) {
    this.gitRoot = options.gitRoot;
    this.onEvent = options.onEvent;
    this.debounceMs = options.debounceMs ?? 100;
    this.allowedEvents = options.allowedEvents ?? null;
  }

  async start() {
    if (this.watchers.length > 0) return;

    const { gitDir, commonDir } = await resolveGitDirs(this.gitRoot);

    const handler = (_eventType: string, filename: string | null) => {
      if (!filename) return;
      const events = this.classifyChange(filename);
      for (const event of events) {
        this.emitDebounced(event);
      }
    };

    this.watchers.push(watch(gitDir, { recursive: true }, handler));

    // In worktrees, commonDir differs from gitDir — watch it too for objects/refs
    if (commonDir !== gitDir) {
      this.watchers.push(watch(commonDir, { recursive: true }, handler));
    }
  }

  stop() {
    for (const watcher of this.watchers) {
      watcher.close();
    }
    this.watchers = [];
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
  }

  private classifyChange(filename: string): WatchEvent[] {
    return classifyGitChange(filename);
  }

  private emitDebounced(event: WatchEvent) {
    stress.track("git-watch", { event });
    if (this.allowedEvents && !this.allowedEvents.has(event)) return;

    const existing = this.debounceTimers.get(event);
    if (existing) {
      clearTimeout(existing);
    }

    const timer = setTimeout(() => {
      this.debounceTimers.delete(event);
      const desc =
        event === "status"
          ? "Detected index change, refreshing status"
          : event === "refs"
            ? "Detected ref update, refreshing refs"
            : event === "worktrees"
              ? "Detected worktree change, refreshing worktree list"
              : "Detected branch/tag change, refreshing log";
      log.debug(desc);
      this.onEvent(event);
    }, this.debounceMs);

    this.debounceTimers.set(event, timer);
  }
}
