import { lstat } from "node:fs/promises";
import path from "node:path";

import { logger } from "./logger";

const log = logger.child("server");

/**
 * Quiet period before collected dependency changes are reported. Installs write in bursts, and a
 * package reported halfway is only fixed by reporting it again, so waiting for the install to go
 * quiet saves the language server a rebuild per burst.
 */
const QUIET_MS = 1000;
/** Longest changes wait for quiet, so a process writing into `node_modules` cannot hold them. */
const MAX_WAIT_MS = 10_000;
/**
 * Files whose own change is reported, besides their package: TypeScript reloads a file it already
 * read (a package upgraded in place, as npm, yarn and bun do) only when that file is reported, not
 * its package directory. JavaScript is left out, as the bulk of an install that type checking
 * rarely reads.
 */
const TYPE_FILE = /\.(?:[cm]?tsx?|json)$/;
/** Most type files held at once; packages are always kept, as they are what resolution needs. */
const TYPE_FILE_LIMIT = 50_000;

/** What a watcher event inside `node_modules` reports; see {@link dependencyChangePaths}. */
export interface DependencyChange {
  /** Each package's directory and its `package.json`. */
  packagePaths: string[];
  /** The changed file itself, when it is a type file. */
  typeFile: string | null;
  /** The innermost package directory the path lies in, or a bare scope directory. */
  packageDir: string;
  /** Whether the path is `packageDir` itself and that is a package, not a scope. */
  isPackageEntry: boolean;
}

/**
 * The worktree-relative paths (`/`-separated) to report to language servers for a watcher event
 * at `relPath` inside a git-ignored `node_modules`; null when it is in no package.
 *
 * Each package the path lies in, top-level or scoped and at every `node_modules` level, is
 * reported as its directory and its `package.json`, which is what makes TypeScript resolve a new,
 * removed or relinked (pnpm) package again. A changed type file is reported too (see
 * {@link TYPE_FILE}). Dot entries (`.pnpm`, `.bin`, `.cache`, install markers, npm's staging
 * directories) are skipped: pnpm's store is content-addressed and changes by relinking.
 */
export function dependencyChangePaths(relPath: string): DependencyChange | null {
  const segments = relPath.split("/");
  const packagePaths: string[] = [];
  let packageEnd = 0;
  let isScope = false;
  let i = segments.indexOf("node_modules");
  while (i !== -1) {
    const name = segments[i + 1];
    if (name === undefined || name.startsWith(".")) break;
    let end = i + 2;
    if (name.startsWith("@")) {
      const scoped = segments[i + 2];
      if (scoped?.startsWith(".")) break;
      // A scope directory alone (`node_modules/@types`) is reported as itself.
      if (scoped !== undefined) end = i + 3;
      isScope = scoped === undefined;
    }
    packageEnd = end;
    const pkg = segments.slice(0, end).join("/");
    packagePaths.push(pkg, `${pkg}/package.json`);
    i = segments.indexOf("node_modules", end);
  }
  if (packagePaths.length === 0) return null;
  const isTypeFile = TYPE_FILE.test(relPath) && !packagePaths.includes(relPath);
  return {
    packagePaths,
    typeFile: isTypeFile ? relPath : null,
    packageDir: segments.slice(0, packageEnd).join("/"),
    isPackageEntry: !isScope && packageEnd === segments.length,
  };
}

/**
 * The type files of a package directory replaced as a whole, relative to the worktree. Skips a
 * symlinked package (pnpm, workspace links): its target's paths are what servers read, and they
 * change by relinking. Dot entries are skipped like in {@link dependencyChangePaths}.
 */
async function* replacedPackageTypeFiles(root: string, packageDir: string): AsyncGenerator<string> {
  const dir = path.join(root, packageDir);
  try {
    if (!(await lstat(dir)).isDirectory()) return;
  } catch {
    return;
  }
  const files = new Bun.Glob("**/*").scan({ cwd: dir, onlyFiles: true, followSymlinks: false });
  for await (const file of files) {
    const relPath = `${packageDir}/${file.replaceAll(path.sep, "/")}`;
    if (TYPE_FILE.test(relPath)) yield relPath;
  }
}

/**
 * Turns a worktree's file-watcher events inside git-ignored `node_modules` directories into
 * absolute paths for the language servers' file-change forwarders, which report each to the
 * servers that registered a matching watcher (TypeScript registers `<dir>/node_modules/**`).
 * Fed from the watcher the worktree already runs, so nothing watches `node_modules` on its own.
 *
 * A package directory moved into place as a whole (bun clones or renames it) brings no event for
 * the files in it, so a package whose own entry changed without any event inside it has its type
 * files listed from disk when the changes are reported.
 */
export class NodeModulesChanges {
  private readonly pending = new Set<string>();
  private typeFiles = 0;
  /** Packages whose own directory entry changed. */
  private readonly entries = new Set<string>();
  /** Packages with a changed path inside them. */
  private readonly touched = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** When the oldest pending path was added; they go out by {@link MAX_WAIT_MS} after. */
  private pendingSince = 0;
  private disposed = false;

  constructor(
    /** Absolute worktree path the event paths are relative to. */
    private readonly root: string,
    private readonly onChanged: (absPaths: string[]) => void,
    private readonly quietMs = QUIET_MS,
    private readonly maxWaitMs = MAX_WAIT_MS,
  ) {}

  /** Record a watcher event at a worktree-relative, `/`-separated path inside an ignored directory. */
  add(relPath: string): void {
    if (this.disposed) return;
    const change = dependencyChangePaths(relPath);
    if (!change) return;
    const now = Date.now();
    if (this.pending.size === 0) this.pendingSince = now;
    for (const p of change.packagePaths) this.pending.add(p);
    if (change.typeFile) this.addTypeFile(change.typeFile);
    if (change.isPackageEntry) this.entries.add(change.packageDir);
    else this.touched.add(change.packageDir);
    if (this.timer) clearTimeout(this.timer);
    const delay = Math.min(this.quietMs, this.pendingSince + this.maxWaitMs - now);
    this.timer = setTimeout(
      () => {
        this.flush().catch((err: unknown) =>
          log.warn("Reporting node_modules changes failed", { error: err }),
        );
      },
      Math.max(0, delay),
    );
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.reset();
  }

  private addTypeFile(relPath: string): void {
    if (this.typeFiles >= TYPE_FILE_LIMIT || this.pending.has(relPath)) return;
    this.pending.add(relPath);
    this.typeFiles++;
  }

  private reset(): void {
    this.pending.clear();
    this.typeFiles = 0;
    this.entries.clear();
    this.touched.clear();
  }

  private async flush(): Promise<void> {
    this.timer = null;
    const replaced = [...this.entries].filter((dir) => !this.touched.has(dir));
    const paths = new Set(this.pending);
    let budget = TYPE_FILE_LIMIT - this.typeFiles;
    // Later events start a new batch while the replaced packages are listed.
    this.reset();
    for (const dir of replaced) {
      if (budget <= 0) break;
      for await (const file of replacedPackageTypeFiles(this.root, dir)) {
        paths.add(file);
        if (--budget <= 0) break;
      }
    }
    if (this.disposed) return;
    this.onChanged([...paths].map((p) => path.join(this.root, p)));
  }
}
