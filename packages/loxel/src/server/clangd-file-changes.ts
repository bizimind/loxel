import { basename, extname } from "node:path";

import { logger } from "./logger";

const log = logger.child("clangd-lsp");

const C_FAMILY_EXTENSIONS = [
  "c",
  "c++",
  "c++m",
  "cc",
  "ccm",
  "cp",
  "cpp",
  "cppm",
  "cxx",
  "cxxm",
  "def",
  "h",
  "h++",
  "hh",
  "hpp",
  "hxx",
  "inc",
  "inl",
  "ipp",
  "ixx",
  "m",
  "mm",
  "tcc",
  "tpp",
  "txx",
];
const DATABASE_FILES = ["compile_commands.json", "compile_flags.txt"];
const CONFIG_FILES = [".clangd", ".clang-tidy"];
/** clangd's index directory and its parents, which the check at each start looks at. */
const INDEX_DIRECTORY = /(^|\/)\.cache(\/clangd(\/index)?)?$/;
/** What clangd writes itself. */
const INDEX_CONTENTS = /(^|\/)\.cache\/clangd\//;

export type ClangdFileChange = "source" | "database" | "config" | "index-directory";

/** What a changed worktree-relative, `/`-separated path means to clangd, or null for nothing. */
export function classifyChange(relPath: string): ClangdFileChange | null {
  if (INDEX_DIRECTORY.test(relPath)) return "index-directory";
  if (INDEX_CONTENTS.test(relPath)) return null;
  const name = basename(relPath);
  if (DATABASE_FILES.includes(name)) return "database";
  if (CONFIG_FILES.includes(name)) return "config";
  const extension = extname(name).slice(1).toLowerCase();
  return C_FAMILY_EXTENSIONS.includes(extension) ? "source" : null;
}

/** Quiet period before open documents are re-checked: a `git checkout` arrives in several batches. */
export const SOURCE_DEBOUNCE_MS = 500;
/** Longest a re-check waits for quiet, for a build that keeps writing headers. */
export const SOURCE_MAX_WAIT_MS = 5000;
/** Past clangd's 5 s cache of a compile database or config file it has found. */
export const CACHED_FILE_DELAY_MS = 6000;
/** Past clangd's 30 s cache of a compile database it did not find. */
export const MISSING_DATABASE_DELAY_MS = 31_000;
/**
 * Quiet period before a restart brings the index up to date with files changed on disk that are not
 * open, long enough that a burst of edits, or an agent working through a task, costs one restart.
 */
export const INDEX_REFRESH_QUIET_MS = 60_000;
/** Most often the index is refreshed: each restart also rebuilds the open documents. */
export const INDEX_REFRESH_MIN_INTERVAL_MS = 5 * 60_000;
/** Enough to take the events of one replaced directory tree together. */
export const INDEX_DIRECTORY_DEBOUNCE_MS = 100;
/** A `git checkout` writes the worktree first and its index last, and git's answer reads the index. */
export const INDEX_DIRECTORY_RECHECK_MS = 3000;

export interface ClangdFileChangeActions {
  /** Have clangd check its open documents' inputs: dependencies and compile commands. */
  recheck(): void;
  /** Have clangd rebuild its open documents, which is what makes it apply config it has reloaded. */
  rebuild(): void;
  /** Something at the path of clangd's index directory changed. */
  indexDirectoryChanged(): void;
  /** Whether the session has this worktree-relative path open, so that clangd follows its text. */
  isOpen(relPath: string): boolean;
  /**
   * Sources that are not open have changed: clangd's index notices only when it loads, comparing
   * each file's content, and that takes under a second even on a project of hundreds of files.
   */
  refreshIndex(): void;
}

/**
 * Turns one clangd session's changed paths into triggers, timed for what clangd can see. It reloads
 * a compile database or config file only when asked after its cache of the file has run out, and a
 * trigger within that time is lost, so these wait from the last change and a write resets the wait.
 * Whether a database is new does not need finding out: a trigger with nothing new is a no-op, so
 * each change schedules for both caches.
 */
export class ClangdFileChanges {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private sourcesChangedSince: number | null = null;
  private disposed = false;

  constructor(private readonly actions: ClangdFileChangeActions) {}

  pathsChanged(relPaths: readonly string[]): void {
    this.apply(relPaths);
    const closedSource = (relPath: string) =>
      classifyChange(relPath) === "source" && !this.actions.isOpen(relPath);
    if (!this.disposed && relPaths.some(closedSource)) {
      this.refreshIndexAfter(INDEX_REFRESH_QUIET_MS);
    }
  }

  /**
   * A path in a git-ignored directory: build output, where compile databases and generated headers
   * are, but also dependency trees, whose installs must not restart clangd for the index.
   */
  ignoredPathChanged(relPath: string): void {
    this.apply([relPath]);
  }

  private apply(relPaths: readonly string[]): void {
    if (this.disposed) return;
    const changes = new Set(relPaths.map(classifyChange));
    if (changes.has("source")) this.sourcesChanged();
    if (changes.has("database")) {
      this.schedule("database", CACHED_FILE_DELAY_MS, () => this.actions.recheck());
      this.schedule("missing-database", MISSING_DATABASE_DELAY_MS, () => this.actions.recheck());
    }
    if (changes.has("config")) {
      this.schedule("config", CACHED_FILE_DELAY_MS, () => this.actions.rebuild());
    }
    if (changes.has("index-directory")) {
      const check = () => this.actions.indexDirectoryChanged();
      this.schedule("index-directory", INDEX_DIRECTORY_DEBOUNCE_MS, check);
      this.schedule("index-directory-settled", INDEX_DIRECTORY_RECHECK_MS, check);
    }
  }

  /** Ask for the index refresh again later, when now is not the time for it. */
  refreshIndexAfter(delayMs: number): void {
    if (this.disposed) return;
    this.schedule("index-refresh", delayMs, () => this.actions.refreshIndex());
  }

  dispose(): void {
    this.disposed = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  private sourcesChanged(): void {
    const now = Date.now();
    this.sourcesChangedSince ??= now;
    const latest = this.sourcesChangedSince + SOURCE_MAX_WAIT_MS - now;
    this.schedule("source", Math.min(SOURCE_DEBOUNCE_MS, latest), () => {
      this.sourcesChangedSince = null;
      this.actions.recheck();
    });
  }

  private schedule(key: string, delayMs: number, fire: () => void): void {
    clearTimeout(this.timers.get(key));
    this.timers.set(
      key,
      setTimeout(() => {
        this.timers.delete(key);
        // Nothing above this timer would catch it, and an uncaught error stops the whole server.
        try {
          fire();
        } catch (err) {
          log.warn("Could not act on changed files", { trigger: key, error: err });
        }
      }, delayMs),
    );
  }
}
