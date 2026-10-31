import { realpathSync, statSync, watch, type FSWatcher } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import type { GoEnv, GoProjectVersion } from "@/api/go-env-model";
import { isDirectory } from "@/fs-utils";
import { isRecord } from "@/lib/is-record";

import { logger } from "./logger";
import { pathOutsideWorktree } from "./python-env";
import { buildSpawnEnv } from "./shell-env";
import { isInside, isShippedByRepo } from "./shipped-by-repo";
import { measureSpawn } from "./spawn-metrics";

const log = logger.child("server");

/**
 * Set whenever Loxel runs `go` or something that does: Loxel works from what is on the machine, and
 * the user downloads modules and toolchains from a terminal. Even `go env` starts a toolchain
 * download in a project with a newer `toolchain` line without `GOTOOLCHAIN=local`. Without the last
 * two, `go` still reaches the checksum database for a module with no `go.sum` entry and hosts named
 * by `GOPRIVATE` directly.
 */
export const GO_ENV = { GOPROXY: "off", GOTOOLCHAIN: "local", GOSUMDB: "off", GONOPROXY: "none" };

export const GO = process.platform === "win32" ? "go.exe" : "go";
export const GOPLS = process.platform === "win32" ? "gopls.exe" : "gopls";
const GO_ENV_TIMEOUT_MS = 10_000;
const WATCH_DEBOUNCE_MS = 1000;
/** Far above any real `go.mod`; the repository decides what this file is. */
const MAX_PROJECT_FILE_BYTES = 1024 * 1024;
const PROJECT_FILES = ["go.work", "go.mod"] as const;
const GO_ENV_NAMES = ["GOVERSION", "GOROOT", "GOPATH", "GOMODCACHE", "GOMOD", "GOWORK", "GOFLAGS"];

/** Login-shell variables that resolution reads, directly or through `go`. */
const RESOLUTION_ENV_VAR = /^(PATH|GO[A-Z0-9_]+)$/;

// ---------------------------------------------------------------------------
// The shared, memoized resolution per worktree

/** What a {@link subscribeGoEnv} listener hears after each finished resolution. */
export interface GoEnvUpdate {
  env: GoEnv | null;
  /** Something about the toolchain differs from the previous resolution. */
  changed: boolean;
}

interface WorktreeGoEnv {
  listeners: Set<(update: GoEnvUpdate) => void>;
  /** The latest resolution, finished or not; null until something asks for the toolchain. */
  resolution: Promise<GoEnv | null> | null;
  /** The last finished resolution. */
  settled: { env: GoEnv | null } | null;
  watch: GoEnvWatch | null;
}

const worktreeEnvs = new Map<string, WorktreeGoEnv>();

/**
 * Keep the worktree's toolchain memoized and watched while subscribed, and call `listener` after
 * each resolution finishes, also when nothing changed, since a `gopls` may have appeared.
 * Subscribing resolves nothing by itself; the first {@link getGoEnv} does. Returns the unsubscribe
 * function; the memo and its watch go with the last subscriber.
 */
export function subscribeGoEnv(
  worktreePath: string,
  listener: (update: GoEnvUpdate) => void,
): () => void {
  const wtPath = path.resolve(worktreePath);
  let entry = worktreeEnvs.get(wtPath);
  if (!entry) {
    entry = { listeners: new Set(), resolution: null, settled: null, watch: null };
    worktreeEnvs.set(wtPath, entry);
  }
  const subscribed = entry;
  subscribed.listeners.add(listener);
  return () => {
    subscribed.listeners.delete(listener);
    if (subscribed.listeners.size > 0 || worktreeEnvs.get(wtPath) !== subscribed) return;
    subscribed.watch?.close();
    worktreeEnvs.delete(wtPath);
  };
}

/**
 * The worktree's Go toolchain, or null when there is no usable `go`, shared by every caller:
 * memoized while the worktree is subscribed, and waiting for a re-resolution in flight. Without a
 * subscriber it resolves afresh, since nothing would keep a memo current. Never rejects.
 */
export async function getGoEnv(worktreePath: string): Promise<GoEnv | null> {
  const wtPath = path.resolve(worktreePath);
  const entry = worktreeEnvs.get(wtPath);
  if (!entry) return resolveGoEnv(wtPath);
  return entry.resolution ?? startResolution(wtPath, entry);
}

/** Re-resolve a subscribed worktree's toolchain now. */
export function refreshGoEnv(worktreePath: string): void {
  const wtPath = path.resolve(worktreePath);
  const entry = worktreeEnvs.get(wtPath);
  if (entry) startResolution(wtPath, entry);
}

/** Whether a login-shell capture that changed `changedNames` can change a resolution. */
export function canChangeGoEnv(changedNames: Iterable<string>): boolean {
  return Array.from(changedNames).some((name) => RESOLUTION_ENV_VAR.test(name));
}

/** Re-resolve every subscribed worktree that has resolved, when the login-shell capture changed. */
export function refreshAllGoEnvs(changedNames: Iterable<string>): void {
  if (!canChangeGoEnv(changedNames)) return;
  for (const [wtPath, entry] of worktreeEnvs) {
    if (entry.resolution) startResolution(wtPath, entry);
  }
}

function startResolution(wtPath: string, entry: WorktreeGoEnv): Promise<GoEnv | null> {
  const onChange = () => {
    if (worktreeEnvs.get(wtPath) === entry) startResolution(wtPath, entry);
  };
  // Watch before the first resolution so nothing created meanwhile is missed.
  entry.watch ??= watchGoEnv(watchTargets(wtPath, null), onChange);
  const resolution = resolveGoEnv(wtPath);
  entry.resolution = resolution;
  void resolution.then((env) => {
    if (worktreeEnvs.get(wtPath) !== entry || entry.resolution !== resolution) return;
    const previous = entry.settled;
    entry.settled = { env };
    rewatch(wtPath, entry, env, onChange);
    const changed = !previous || !Bun.deepEquals(previous.env, env);
    if (changed)
      log.info("Go toolchain resolved", { wtPath, go: env?.binary, version: env?.version });
    for (const listener of entry.listeners) {
      // One failing listener must not keep the update from the others.
      try {
        listener({ env, changed });
      } catch (err) {
        log.warn("A Go toolchain listener failed", { wtPath, error: err });
      }
    }
  });
  return resolution;
}

/**
 * Watch what `env` calls for, if that differs from what is watched: a watch is not fully armed when
 * it returns, so one that stays cannot miss a change. Keeps the old watch until the new one is armed,
 * and hands a change it saw during resolution to the new one's debounce.
 */
function rewatch(
  wtPath: string,
  entry: WorktreeGoEnv,
  env: GoEnv | null,
  onChange: () => void,
): void {
  const oldWatch = entry.watch;
  const targets = watchTargets(wtPath, env);
  if (oldWatch && Bun.deepEquals(oldWatch.targets, targets)) return;
  entry.watch = watchGoEnv(targets, onChange);
  if (oldWatch?.hasPendingChange) entry.watch.nudge();
  oldWatch?.close();
}

// ---------------------------------------------------------------------------
// Resolution

function realpathOr(target: string): string {
  try {
    return realpathSync(target);
  } catch {
    return target;
  }
}

/**
 * The login-shell PATH for `go` and the tools it runs: only absolute directories, none of them in
 * the worktree, by name or through a symlink, so they cannot pick up something the repository ships.
 */
export function goToolPath(wtPath: string): string {
  const realRoot = realpathOr(wtPath);
  return pathOutsideWorktree(buildSpawnEnv().PATH ?? "", wtPath)
    .split(path.delimiter)
    .filter((dir) => path.isAbsolute(dir) && !isInside(realpathOr(dir), realRoot))
    .join(path.delimiter);
}

/** A version manager's shim: asdf, mise and goenv all keep theirs in a directory of this name. */
function isShim(binary: string): boolean {
  return path.basename(path.dirname(binary)) === "shims";
}

/**
 * What to set in the environment of anything that runs `go` for a worktree, without shim
 * directories, and with the Go that `env`'s shim stands for first.
 */
export function goSpawnEnv(
  wtPath: string,
  env: Pick<GoEnv, "binary" | "goroot"> | null,
): Record<string, string> {
  const dirs = goToolPath(wtPath)
    .split(path.delimiter)
    .filter((dir) => path.basename(dir) !== "shims");
  const first = env?.goroot && isShim(env.binary) ? [path.join(env.goroot, "bin")] : [];
  return { PATH: [...first, ...dirs].join(path.delimiter), ...GO_ENV };
}

/** The first `name` on {@link goToolPath}, unless the repository could have provided it. */
async function trustedOnPath(wtPath: string, name: string): Promise<string | null> {
  const binary = Bun.which(name, { PATH: goToolPath(wtPath) });
  return binary && (await isTrustedBinary(wtPath, binary)) ? binary : null;
}

async function isTrustedBinary(wtPath: string, binary: string): Promise<boolean> {
  const inWorktree = isInside(realpathOr(binary), realpathOr(wtPath));
  if (!inWorktree && !(await isShippedByRepo(wtPath, binary))) return true;
  log.warn("Ignoring a Go tool that the repository ships", { wtPath, binary });
  return false;
}

/**
 * A tool to run in a worktree: the first `name` on {@link goToolPath}, unless it is a shim, is in the
 * worktree through a symlink or is tracked by a repository. A refused one is not passed over for a
 * later one, since what runs `go` would still find it first.
 */
export async function trustedGoTool(wtPath: string, name: string): Promise<string | null> {
  const binary = await trustedOnPath(wtPath, name);
  return binary && !isShim(binary) ? binary : null;
}

/**
 * The Go a shim stands for, found from the home directory: the `go` in the GOROOT it reports. Null
 * when it names none that can be trusted, since nothing else on the PATH has been checked.
 */
async function goBehindShim(wtPath: string, shim: string): Promise<string | null> {
  const { GOROOT } = await goEnvVariables(shim, homedir(), wtPath, ["GOROOT"]);
  if (!GOROOT || !path.isAbsolute(GOROOT)) return null;
  const go = Bun.which(GO, { PATH: path.join(GOROOT, "bin") });
  return go && (await isTrustedBinary(wtPath, go)) ? go : null;
}

async function resolveGoEnv(wtPath: string): Promise<GoEnv | null> {
  try {
    const binary = await trustedOnPath(wtPath, GO);
    if (!binary) return null;
    const go = isShim(binary) ? await goBehindShim(wtPath, binary) : binary;
    if (!go) return null;
    const [reported, project] = await Promise.all([
      goEnvVariables(go, wtPath, wtPath, GO_ENV_NAMES),
      readProjectVersions(wtPath),
    ]);
    const version = versionFromGoVersion(reported.GOVERSION);
    const newerThanInstalled = (found: GoProjectVersion | null) =>
      found && version && compareGoVersions(found.version, version) > 0 ? found : null;
    return {
      binary,
      version,
      goroot: go === binary ? (reported.GOROOT ?? null) : path.dirname(path.dirname(go)),
      gopath: reported.GOPATH ?? null,
      gomodcache: reported.GOMODCACHE ?? null,
      gomod: projectFile(reported.GOMOD),
      gowork: projectFile(reported.GOWORK),
      goflags: reported.GOFLAGS ?? null,
      gopls: await trustedGoTool(wtPath, GOPLS),
      newerGoNeeded: newerThanInstalled(project.go),
      newerToolchainSuggested: newerThanInstalled(project.toolchain),
    };
  } catch (err) {
    log.warn("Could not resolve the Go toolchain", { wtPath, error: err });
    return null;
  }
}

/** The variables `go env` reports with a value, run in `cwd`; empty when it fails. */
async function goEnvVariables(
  binary: string,
  cwd: string,
  wtPath: string,
  names: readonly string[],
): Promise<Record<string, string>> {
  try {
    const proc = measureSpawn("go", () =>
      Bun.spawn([binary, "env", "-json", ...names], {
        cwd,
        env: { ...buildSpawnEnv(), ...goSpawnEnv(wtPath, null) },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "ignore",
        timeout: GO_ENV_TIMEOUT_MS,
        killSignal: "SIGKILL",
      }),
    );
    const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    if (exitCode !== 0) return {};
    const parsed: unknown = JSON.parse(stdout);
    if (!isRecord(parsed)) return {};
    const variables: Record<string, string> = {};
    for (const [name, value] of Object.entries(parsed)) {
      if (typeof value === "string" && value) variables[name] = value;
    }
    return variables;
  } catch (err) {
    log.debug("go env failed", { binary, cwd, error: err });
    return {};
  }
}

/** `GOMOD` is the null device outside a module, and `GOWORK` can be `off`. */
function projectFile(reported: string | undefined): string | null {
  return reported && path.isAbsolute(reported) && reported !== "/dev/null" ? reported : null;
}

/** The highest `go` and `toolchain` lines of the worktree's root `go.work` and `go.mod`. */
async function readProjectVersions(
  wtPath: string,
): Promise<{ go: GoProjectVersion | null; toolchain: GoProjectVersion | null }> {
  let go: GoProjectVersion | null = null;
  let toolchain: GoProjectVersion | null = null;
  const higher = (current: GoProjectVersion | null, next: GoProjectVersion | null) =>
    next && (!current || compareGoVersions(next.version, current.version) > 0) ? next : current;
  for (const file of PROJECT_FILES) {
    const text = await readProjectFile(path.join(wtPath, file));
    if (text === null) continue;
    const lineVersion = (line: RegExp) => {
      const version = parseGoVersion(line.exec(text)?.[1]);
      return version ? { file, version } : null;
    };
    go = higher(go, lineVersion(/^go[ \t]+(\S+)/m));
    toolchain = higher(toolchain, lineVersion(/^toolchain[ \t]+go(\S+)/m));
  }
  return { go, toolchain };
}

async function readProjectFile(file: string): Promise<string | null> {
  try {
    // A repository can commit a FIFO, or a symlink to a device, under this name.
    const info = statSync(file);
    if (!info.isFile() || info.size > MAX_PROJECT_FILE_BYTES) return null;
    return await Bun.file(file).text();
  } catch {
    return null;
  }
}

const GO_VERSION = /^(\d+)\.(\d+)(?:\.(\d+)|(beta|rc)(\d+))?/;

/** The start of `text` that is a Go version: `1.27`, `1.27.3`, `1.27rc1`. */
function parseGoVersion(text: string | undefined): string | null {
  return (text && GO_VERSION.exec(text)?.[0]) || null;
}

/** The version in `GOVERSION`: `go1.27.3`, `go1.27.3 X:rangefunc`, `devel go1.28-abcdef`. */
function versionFromGoVersion(goVersion: string | undefined): string | null {
  return parseGoVersion(goVersion && /go(\d.*)/.exec(goVersion)?.[1]);
}

/**
 * Go's order of versions, in which a language version comes before its releases:
 * `1.27 < 1.27beta1 < 1.27rc1 < 1.27.0 < 1.27.1`. Negative when `a` comes before `b`.
 */
export function compareGoVersions(a: string, b: string): number {
  const key = (version: string): number[] => {
    const [, major, minor, patch, kind, pre] = GO_VERSION.exec(version) ?? [];
    let stage = 0;
    if (kind === "beta") stage = 1;
    else if (kind === "rc") stage = 2;
    else if (patch !== undefined) stage = 3;
    return [Number(major), Number(minor), stage, Number(patch ?? pre ?? 0)];
  };
  const [keyA, keyB] = [key(a), key(b)];
  for (const [i, part] of keyA.entries()) {
    const difference = part - (keyB[i] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Watching

interface GoEnvWatch {
  readonly targets: WatchTargets;
  close(): void;
  /** True when a change was seen whose debounced `onChange` has not fired yet. */
  readonly hasPendingChange: boolean;
  /** Report a change seen elsewhere, through the same debounce. */
  nudge(): void;
}

/** Directories to watch, each with the entry names that matter there. */
type WatchTargets = Map<string, Set<string>>;

/**
 * Call `onChange` (debounced) when the worktree's toolchain may have changed: a root `go.mod` or
 * `go.work` changing, or `go` or `gopls` appearing in, changing in or leaving a PATH directory.
 * Watches are non-recursive and fixed to the layout seen when {@link watchTargets} ran.
 */
function watchGoEnv(targets: WatchTargets, onChange: () => void): GoEnvWatch {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      onChange();
    }, WATCH_DEBOUNCE_MS);
  };

  const watchers: FSWatcher[] = [];
  for (const [dir, names] of targets) {
    try {
      const watcher = watch(dir, (_event, filename) => {
        // A null filename means the platform could not say what changed; treat it as relevant.
        if (filename === null || names.has(filename)) schedule();
      });
      watcher.on("error", (err) => log.debug("Go toolchain watch failed", { dir, error: err }));
      watchers.push(watcher);
    } catch (err) {
      log.debug("Could not watch for Go toolchain changes", { dir, error: err });
    }
  }

  return {
    targets,
    close() {
      if (timer) clearTimeout(timer);
      timer = null;
      for (const watcher of watchers) watcher.close();
    },
    get hasPendingChange() {
      return timer !== null;
    },
    nudge: schedule,
  };
}

function watchTargets(wtPath: string, current: GoEnv | null): WatchTargets {
  const targets: WatchTargets = new Map();
  const add = (dir: string, name: string) => {
    const names = targets.get(dir);
    if (names) names.add(name);
    else targets.set(dir, new Set([name]));
  };
  for (const file of PROJECT_FILES) add(wtPath, file);
  for (const dir of goToolPath(wtPath).split(path.delimiter).filter(Boolean)) {
    if (isDirectory(dir)) {
      add(dir, GO);
      add(dir, GOPLS);
      continue;
    }
    // A tarball install removes its `bin` first: its deepest existing ancestor sees it come back.
    let missing = dir;
    while (!isDirectory(path.dirname(missing)) && path.dirname(missing) !== missing) {
      missing = path.dirname(missing);
    }
    add(path.dirname(missing), path.basename(missing));
  }
  if (current) {
    // `go` on the PATH is often a symlink, whose target can be replaced without touching the link.
    const real = realpathOr(current.binary);
    add(path.dirname(real), path.basename(real));
  }
  return targets;
}
