import { existsSync, readdirSync } from "node:fs";
import path from "node:path";

import { dirsUpToRoot } from "./language-formatter";
import { logger } from "./logger";

const log = logger.child("rust-lsp");

const RUST_FILE = ".rs";

/** Past the batching of `lsp-watched-files.ts`, as a save the server has no file change for is lost. */
export const CHECK_QUIET_MS = 500;
/** Longest a check waits for quiet, for something that keeps writing files. */
export const CHECK_MAX_WAIT_MS = 5000;

export interface RustCheckActions {
  /** The linked project that checks this file, or null when none does. */
  linkedProjectOf(file: string): string | null;
  /** Have the server check the project that owns this file. */
  save(file: string): void;
}

/** An existing Rust file closest to one that is gone, for the server knows only existing ones. */
function rustFileNear(file: string, wtPath: string): string | null {
  for (const dir of dirsUpToRoot(path.dirname(file), wtPath)) {
    try {
      const sibling = readdirSync(dir, { withFileTypes: true }).find(
        (entry) => entry.isFile() && entry.name.endsWith(RUST_FILE),
      );
      if (sibling) return path.join(dir, sibling.name);
    } catch {
      // A directory that went too; the one above it still counts.
    }
  }
  return null;
}

async function contentHash(file: string): Promise<bigint | number | null> {
  try {
    return Bun.hash(await Bun.file(file).bytes());
  } catch {
    return null;
  }
}

/**
 * Turns the `.rs` files changing on disk into one save per linked project, since rust-analyzer starts
 * a check only on a save and a project's check covers its whole workspace. Whoever made the change:
 * an agent's edit or a `git checkout` touches files that are not open.
 *
 * Only a change of content counts. A build script that writes source files would otherwise start a
 * check that runs it again, without end.
 */
export class RustCheckOnChange {
  private readonly pending = new Set<string>();
  private readonly knownContent = new Map<string, bigint | number | null>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pendingSince: number | null = null;
  private flushing: Promise<void> = Promise.resolve();
  private disposed = false;

  constructor(
    private readonly wtPath: string,
    private readonly actions: RustCheckActions,
  ) {}

  pathsChanged(paths: readonly string[]): void {
    if (this.disposed) return;
    const files = paths.filter((changed) => changed.endsWith(RUST_FILE));
    if (files.length === 0) return;
    for (const file of files) this.pending.add(file);
    const now = Date.now();
    this.pendingSince ??= now;
    if (this.timer) clearTimeout(this.timer);
    const latest = this.pendingSince + CHECK_MAX_WAIT_MS - now;
    this.timer = setTimeout(() => this.flush(), Math.min(CHECK_QUIET_MS, latest));
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.pending.clear();
  }

  /** Settles once every batch that has come due has been handled. */
  idle(): Promise<void> {
    return this.flushing;
  }

  private flush(): void {
    this.timer = null;
    this.pendingSince = null;
    const files = [...this.pending];
    this.pending.clear();
    this.flushing = this.flushing
      .then(() => this.saveProjectsOf(files))
      .catch((err: unknown) => {
        log.warn("Could not start a check for changed Rust files", { error: err });
      });
  }

  private async saveProjectsOf(files: readonly string[]): Promise<void> {
    const toSave = new Map<string, string>();
    const projectOfDir = new Map<string, string | null>();
    for (const file of files) {
      const existing = existsSync(file) ? file : rustFileNear(file, this.wtPath);
      const dir = existing && path.dirname(existing);
      if (!existing || !dir) {
        this.knownContent.set(file, null);
        continue;
      }
      const project = projectOfDir.has(dir)
        ? (projectOfDir.get(dir) ?? null)
        : this.actions.linkedProjectOf(existing);
      projectOfDir.set(dir, project);
      if (project === null || toSave.has(project)) {
        // Not compared now, so a later return to the content known from before still counts.
        this.knownContent.delete(file);
        continue;
      }
      const content = await contentHash(file);
      if (this.knownContent.get(file) === content) continue;
      this.knownContent.set(file, content);
      toSave.set(project, existing);
    }
    if (this.disposed) return;
    for (const file of toSave.values()) this.actions.save(file);
  }
}
