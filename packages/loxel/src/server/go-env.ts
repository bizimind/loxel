import { accessSync, constants, realpathSync, statSync, watch, type FSWatcher } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import type { GoEnv, GoEnvSource, GoProjectVersion } from "@/api/go-env-model";
import { isDirectory } from "@/fs-utils";
import { isRecord } from "@/lib/is-record";

import { getGoChoice } from "./go-toolchain-store";
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
const GO_ENV_NAMES = [
  "GOVERSION",
  "GOROOT",
  "GOPATH",
  "GOMODCACHE",
  "GOMOD",
  "GOWORK",
  "GOFLAGS",
  "GOHOSTOS",
  "GOHOSTARCH",
];

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
  /** The choice the latest resolution read. */
  chosen: string | null;
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
    entry = { listeners: new Set(), resolution: null, settled: null, chosen: null, watch: null };
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
  // A choice just made may not have reached the store's change hook yet.
  if (entry.resolution && entry.chosen === getGoChoice(wtPath)) return entry.resolution;
  return startResolution(wtPath, entry);
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
  entry.chosen = getGoChoice(wtPath);
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

export function realpathOr(target: string): string {
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
export function isShim(binary: string): boolean {
  return path.basename(path.dirname(binary)) === "shims";
}

/**
 * What to set in the environment of anything that runs `go` for a worktree, without shim
 * directories, and with the Go that `env` stands for first when that is not simply the PATH's. A
 * chosen or cached Go gets its GOROOT too, over one the login shell may export for another Go.
 */
export function goSpawnEnv(
  wtPath: string,
  env: Pick<GoEnv, "binary" | "goroot" | "source"> | null,
): Record<string, string> {
  const dirs = goToolPath(wtPath)
    .split(path.delimiter)
    .filter((dir) => path.basename(dir) !== "shims");
  const goroot = env?.goroot;
  const own: Record<string, string> = goroot && env.source !== "path" ? { GOROOT: goroot } : {};
  const first = goroot && (env.source !== "path" || isShim(env.binary));
  return {
    PATH: [...(first ? [path.join(goroot, "bin")] : []), ...dirs].join(path.delimiter),
    ...own,
    ...GO_ENV,
  };
}

/** The first `name` on {@link goToolPath}, unless the repository could have provided it. */
async function trustedOnPath(wtPath: string, name: string): Promise<string | null> {
  const binary = Bun.which(name, { PATH: goToolPath(wtPath) });
  return binary && (await isTrustedBinary(wtPath, binary)) ? binary : null;
}

export async function isTrustedBinary(wtPath: string, binary: string): Promise<boolean> {
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
export async function goBehindShim(wtPath: string, shim: string): Promise<string | null> {
  const { GOROOT } = await goEnvVariables(shim, homedir(), wtPath, ["GOROOT"]);
  if (!GOROOT || !path.isAbsolute(GOROOT)) return null;
  const go = Bun.which(GO, { PATH: path.join(GOROOT, "bin") });
  return go && (await isTrustedBinary(wtPath, go)) ? go : null;
}

export function isExecutableFile(file: string): boolean {
  try {
    if (!statSync(file).isFile()) return false;
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** The worktree's chosen Go when it can still be used, then what detection finds. Never rejects. */
async function resolveGoEnv(wtPath: string): Promise<GoEnv | null> {
  try {
    const chosen = getGoChoice(wtPath);
    return (chosen && (await chosenGoEnv(wtPath, chosen))) || (await detectGoEnv(wtPath));
  } catch (err) {
    log.warn("Could not resolve the Go toolchain", { wtPath, error: err });
    return null;
  }
}

/** What detection finds for the worktree, whatever is chosen. */
export async function automaticGoEnv(wtPath: string): Promise<GoEnv | null> {
  try {
    return await detectGoEnv(wtPath);
  } catch (err) {
    log.warn("Could not resolve the Go toolchain", { wtPath, error: err });
    return null;
  }
}

/** Null when the chosen Go is gone, or the trust rule refuses it or the GOROOT it reports. */
async function chosenGoEnv(wtPath: string, chosen: string): Promise<GoEnv | null> {
  if (isShim(chosen) || !isExecutableFile(chosen)) return null;
  if (!(await isTrustedBinary(wtPath, chosen))) return null;
  const env = await describeGo(wtPath, chosen, chosen, "chosen");
  const inRoot = env.goroot && Bun.which(GO, { PATH: path.join(env.goroot, "bin") });
  return inRoot && (await isTrustedBinary(wtPath, inRoot)) ? env : null;
}

async function detectGoEnv(wtPath: string): Promise<GoEnv | null> {
  const binary = await trustedOnPath(wtPath, GO);
  if (!binary) return null;
  const go = isShim(binary) ? await goBehindShim(wtPath, binary) : binary;
  if (!go) return null;
  const detected = await describeGo(wtPath, binary, go, "path");
  return (await moduleCacheGoEnv(wtPath, detected)) ?? detected;
}

/**
 * The project's version from the module cache, when the project asks for newer than `detected`:
 * the highest it asks for, or failing that the `go` line, which is what it needs to load.
 */
async function moduleCacheGoEnv(wtPath: string, detected: GoEnv): Promise<GoEnv | null> {
  const { gomodcache, toolchainPlatform: platform } = detected;
  if (!gomodcache || !platform) return null;
  const wanted = [detected.newerToolchainSuggested, detected.newerGoNeeded]
    .filter((found) => found !== null)
    .map((found) => found.version)
    .toSorted((a, b) => compareGoVersions(b, a));
  for (const version of wanted) {
    const name = cachedToolchainDirName(version, platform);
    const go = name && (await cachedGo(wtPath, gomodcache, name));
    if (!go) continue;
    const env = await describeGo(wtPath, go, go, "module-cache");
    if (env.version === releaseOf(version)) return env;
    log.warn("A cached Go toolchain does not report its version", { go, version: env.version });
  }
  return null;
}

/** `go env` from `go`, in the worktree, as `binary`, with the project's versions compared to it. */
async function describeGo(
  wtPath: string,
  binary: string,
  go: string,
  source: GoEnvSource,
): Promise<GoEnv> {
  const [reported, project] = await Promise.all([
    goEnvVariables(go, wtPath, wtPath, GO_ENV_NAMES, source !== "path"),
    readProjectVersions(wtPath),
  ]);
  const version = versionFromGoVersion(reported.GOVERSION);
  const newerThanThis = (found: GoProjectVersion | null) =>
    found && version && compareGoVersions(found.version, version) > 0 ? found : null;
  const ownRoot = reported.GOROOT ?? path.dirname(path.dirname(realpathOr(go)));
  const { GOHOSTOS: hostOs, GOHOSTARCH: hostArch } = reported;
  let goroot = reported.GOROOT ?? null;
  if (source !== "path") goroot = ownRoot;
  else if (go !== binary) goroot = path.dirname(path.dirname(go));
  return {
    binary,
    source,
    version,
    goroot,
    gopath: reported.GOPATH ?? null,
    gomodcache: reported.GOMODCACHE ?? null,
    toolchainPlatform: hostOs && hostArch ? `${hostOs}-${hostArch}` : null,
    gomod: projectFile(reported.GOMOD),
    gowork: projectFile(reported.GOWORK),
    goflags: reported.GOFLAGS ?? null,
    gopls: await trustedGoTool(wtPath, GOPLS),
    newerGoNeeded: newerThanThis(project.go),
    newerToolchainSuggested: newerThanThis(project.toolchain),
  };
}

/** A login-shell environment to run `go` in, for a Go that must work out its own GOROOT. */
function ownGorootEnv(wtPath: string): Record<string, string | undefined> {
  const { GOROOT: _, ...env } = buildSpawnEnv();
  return { ...env, ...goSpawnEnv(wtPath, null) };
}

/**
 * The version a `go` binary reports, from the home directory; null when it does not answer like a
 * Go. Takes a binary not yet known to be Go, so the output is matched strictly.
 */
export async function goVersion(wtPath: string, go: string): Promise<string | null> {
  try {
    const proc = measureSpawn("go", () =>
      Bun.spawn([go, "version"], {
        cwd: homedir(),
        env: ownGorootEnv(wtPath),
        stdin: "ignore",
        stdout: "pipe",
        stderr: "ignore",
        timeout: GO_ENV_TIMEOUT_MS,
        killSignal: "SIGKILL",
      }),
    );
    const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    if (exitCode !== 0) return null;
    return versionFromGoVersion(/^go version (\S+) \S+\/\S+/.exec(stdout)?.[1]);
  } catch (err) {
    log.debug("go version failed", { go, error: err });
    return null;
  }
}

// ---------------------------------------------------------------------------
// Toolchains in the module cache

/** `v0.0.1` is the only version the Go project publishes toolchains under. */
const TOOLCHAIN_PREFIX = "toolchain@v0.0.1-go";
const TOOLCHAIN_PLATFORM = /^[a-z0-9]+-[a-z0-9]+$/;

/**
 * The toolchain that serves `version`: the first release of a language version, as `go` asks for
 * (`go 1.26` in a `go.mod` means `go1.26.0`).
 */
function releaseOf(version: string): string {
  return /^\d+\.\d+$/.test(version) ? `${version}.0` : version;
}

/**
 * The directory name of `version`'s toolchain under `GOMODCACHE/golang.org`. The version comes from
 * a repository's file, so anything but the exact shape of a Go version gives null.
 */
export function cachedToolchainDirName(version: string, platform: string): string | null {
  if (!PROJECT_GO_VERSION.test(version) || !TOOLCHAIN_PLATFORM.test(platform)) return null;
  return `${TOOLCHAIN_PREFIX}${releaseOf(version)}.${platform}`;
}

/** The inverse of {@link cachedToolchainDirName}; null for any other name. */
export function cachedToolchainVersion(name: string, platform: string): string | null {
  const suffix = `.${platform}`;
  if (!name.startsWith(TOOLCHAIN_PREFIX) || !name.endsWith(suffix)) return null;
  const version = name.slice(TOOLCHAIN_PREFIX.length, -suffix.length);
  return cachedToolchainDirName(version, platform) === name ? version : null;
}

/**
 * The `go` of toolchain directory `name` in the module cache, only if it is already there, runnable
 * and trusted, and neither it nor its directory lead out of the cache through a symlink.
 */
export async function cachedGo(
  wtPath: string,
  gomodcache: string,
  name: string,
): Promise<string | null> {
  if (!path.isAbsolute(gomodcache)) return null;
  const dir = path.join(gomodcache, "golang.org", name);
  const go = Bun.which(GO, { PATH: path.join(dir, "bin") });
  if (!go) return null;
  const realCache = realpathOr(gomodcache);
  const realDir = realpathOr(dir);
  if (
    realDir === realCache ||
    !isInside(realDir, realCache) ||
    !isInside(realpathOr(go), realDir)
  ) {
    log.warn("Ignoring a cached Go toolchain that leads out of the module cache", { dir });
    return null;
  }
  return (await isTrustedBinary(wtPath, go)) ? go : null;
}

// ---------------------------------------------------------------------------
// Reading what Go and the project report

/**
 * The variables `go env` reports with a value, run in `cwd`; empty when it fails. With `ownGoroot`,
 * a GOROOT the login shell exports, likely for another Go, does not reach it.
 */
async function goEnvVariables(
  binary: string,
  cwd: string,
  wtPath: string,
  names: readonly string[],
  ownGoroot = false,
): Promise<Record<string, string>> {
  try {
    const proc = measureSpawn("go", () =>
      Bun.spawn([binary, "env", "-json", ...names], {
        cwd,
        env: ownGoroot ? ownGorootEnv(wtPath) : { ...buildSpawnEnv(), ...goSpawnEnv(wtPath, null) },
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
      const version = line.exec(text)?.[1];
      return version && PROJECT_GO_VERSION.test(version) ? { file, version } : null;
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

/** A version as a repository's file may state it, whole: nothing a path could be built from. */
const PROJECT_GO_VERSION = /^\d{1,9}\.\d{1,9}(?:\.\d{1,9}|(?:beta|rc)\d{1,9})?$/;

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
 * `go.work` changing, `go` or `gopls` appearing in, changing in or leaving a PATH directory, the
 * chosen Go changing, or a toolchain the project asks for appearing in the module cache.
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
  // What may not exist yet, by the deepest ancestor that does: a tarball install removes its `bin`
  // first, and that ancestor sees it come back.
  const addByAncestor = (target: string) => {
    let missing = target;
    while (!isDirectory(path.dirname(missing)) && path.dirname(missing) !== missing) {
      missing = path.dirname(missing);
    }
    add(path.dirname(missing), path.basename(missing));
  };
  for (const file of PROJECT_FILES) add(wtPath, file);
  for (const dir of goToolPath(wtPath).split(path.delimiter).filter(Boolean)) {
    if (isDirectory(dir)) {
      add(dir, GO);
      add(dir, GOPLS);
    } else {
      addByAncestor(dir);
    }
  }
  const chosen = getGoChoice(wtPath);
  if (chosen) addByAncestor(chosen);
  const { gomodcache, toolchainPlatform: platform } = current ?? {};
  if (current && current.source !== "chosen" && gomodcache && platform) {
    for (const wanted of [current.newerGoNeeded, current.newerToolchainSuggested]) {
      const name = wanted && cachedToolchainDirName(wanted.version, platform);
      if (!name || !path.isAbsolute(gomodcache)) continue;
      const dir = path.join(gomodcache, "golang.org", name);
      addByAncestor(dir);
      // `go` makes its binaries executable only after unpacking.
      if (isDirectory(path.join(dir, "bin"))) add(path.join(dir, "bin"), GO);
    }
  }
  if (current) {
    // `go` on the PATH is often a symlink, whose target can be replaced without touching the link.
    const real = realpathOr(current.binary);
    add(path.dirname(real), path.basename(real));
  }
  return targets;
}
