import { watch, type FSWatcher } from "node:fs";
import { mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

import type {
  RustToolchain,
  RustToolchainChoice,
  RustToolchainSource,
  RustTools,
} from "@/api/rust-toolchain-model";
import { isDirectory } from "@/fs-utils";

import { logger } from "./logger";
import { pathOutsideWorktree } from "./python-env";
import { isVersionManagerShim } from "./rust-tool-shim";
import { getRustChoice } from "./rust-toolchain-store";
import { buildSpawnEnv, refreshLoginShellEnv } from "./shell-env";
import { isInside, isShippedByRepo } from "./shipped-by-repo";

const log = logger.child("server");

const COMMAND_TIMEOUT_MS = 10_000;
/** Quiet period after the last filesystem event before re-resolving (rustup writes in bursts). */
const WATCH_DEBOUNCE_MS = 1000;
const TOOLCHAIN_FILES = ["rust-toolchain", "rust-toolchain.toml"];
const PLAIN_TOOLS = ["rustc", "cargo", "rustfmt", "cargo-clippy"];

/**
 * Keeps rustup from installing anything for a process Loxel itself starts: without it, `rustc`,
 * `rustup show active-toolchain` and `rustup toolchain list` download a toolchain a
 * `rust-toolchain.toml` pins. A user's own `cargo` in a terminal keeps rustup's normal behavior, so
 * this is separate from {@link rustChosenEnv}.
 */
export const RUST_LOXEL_TOOL_ENV = { RUSTUP_AUTO_INSTALL: "0" } as const;

type SpawnEnv = Record<string, string | undefined>;

// ---------------------------------------------------------------------------
// What the consumers apply when they spawn

/**
 * The user's choice as spawn variables, the part that also suits a terminal, where a user's own
 * `cargo` keeps rustup's normal behavior. `RUSTUP_TOOLCHAIN` beats a toolchain file. Taken from a resolved toolchain, so a choice
 * that is no longer installed never reaches a process, where rustup would try to install it.
 */
export function rustChosenEnv(toolchain: RustToolchain): { RUSTUP_TOOLCHAIN?: string } {
  return toolchain.status === "active" && toolchain.source === "chosen" && toolchain.name
    ? { RUSTUP_TOOLCHAIN: toolchain.name }
    : {};
}

/** The variables for a Rust tool Loxel itself starts: the choice, and no installing. */
export function rustToolEnv(toolchain: RustToolchain): {
  RUSTUP_AUTO_INSTALL: "0";
  RUSTUP_TOOLCHAIN?: string;
} {
  return { ...RUST_LOXEL_TOOL_ENV, ...rustChosenEnv(toolchain) };
}

// ---------------------------------------------------------------------------
// The shared, memoized resolution per worktree

/** What a {@link subscribeRustToolchain} listener hears after each finished resolution. */
export interface RustToolchainUpdate {
  toolchain: RustToolchain;
  /** The worktree's first resolution since it was subscribed. */
  first: boolean;
  /** The toolchain, what it offers, or the chosen one differs from the previous resolution's. */
  changed: boolean;
}

interface WorktreeRustToolchain {
  listeners: Set<(update: RustToolchainUpdate) => void>;
  /** The latest resolution, finished or not; null until something asks for the toolchain. */
  resolution: Promise<RustToolchain> | null;
  /** The last finished resolution and the choice it was made with. */
  settled: { toolchain: RustToolchain; chosen: string | null } | null;
  /** True while {@link resolution} has not finished. */
  pending: boolean;
  /** The settled toolchain failed the toolchain rule since, so it is not handed out any more. */
  withdrawn: boolean;
  /** The choice the latest resolution started with. */
  chosen: string | null;
  watch: RustToolchainWatch | null;
}

const worktreeToolchains = new Map<string, WorktreeRustToolchain>();

/**
 * Keep the worktree's resolution memoized and watched while subscribed, and call `listener` after
 * each resolution finishes. Subscribing resolves nothing by itself, so a worktree without Rust
 * files costs nothing; the first {@link getRustToolchain} does. Returns the unsubscribe function;
 * the memo and its watch go with the last subscriber.
 */
export function subscribeRustToolchain(
  worktreePath: string,
  listener: (update: RustToolchainUpdate) => void,
): () => void {
  const wtPath = path.resolve(worktreePath);
  let entry = worktreeToolchains.get(wtPath);
  if (!entry) {
    entry = {
      listeners: new Set(),
      resolution: null,
      settled: null,
      pending: false,
      withdrawn: false,
      chosen: null,
      watch: null,
    };
    worktreeToolchains.set(wtPath, entry);
  }
  const subscribed = entry;
  subscribed.listeners.add(listener);
  return () => {
    subscribed.listeners.delete(listener);
    if (subscribed.listeners.size > 0 || worktreeToolchains.get(wtPath) !== subscribed) return;
    subscribed.watch?.close();
    worktreeToolchains.delete(wtPath);
  };
}

/**
 * The worktree's toolchain (see {@link resolveRustToolchain}), shared by every caller: memoized
 * while the worktree is subscribed, and waiting for a re-resolution in flight. Without a subscriber
 * it resolves afresh, since nothing would keep a memo current.
 */
export async function getRustToolchain(worktreePath: string): Promise<RustToolchain> {
  const wtPath = path.resolve(worktreePath);
  const entry = worktreeToolchains.get(wtPath);
  if (!entry) return resolveRustToolchain(wtPath);
  await revalidate(wtPath, entry);
  // Unsubscribed meanwhile: nothing would close a watch armed for it now.
  if (worktreeToolchains.get(wtPath) !== entry) return resolveRustToolchain(wtPath);
  return entry.resolution ?? startResolution(wtPath, entry);
}

/**
 * Like {@link getRustToolchain}, but answers with the last finished resolution while a
 * re-resolution is in flight, for callers that hear about the fresh one through
 * {@link subscribeRustToolchain}.
 */
export async function getRustToolchainNow(worktreePath: string): Promise<RustToolchain> {
  const wtPath = path.resolve(worktreePath);
  const entry = worktreeToolchains.get(wtPath);
  if (!entry) return resolveRustToolchain(wtPath);
  await revalidate(wtPath, entry);
  if (worktreeToolchains.get(wtPath) !== entry) return resolveRustToolchain(wtPath);
  // Not one made with an older choice: it could name a toolchain that is gone.
  if (entry.pending && entry.settled?.chosen === entry.chosen && !entry.withdrawn) {
    return entry.settled.toolchain;
  }
  return entry.resolution ?? startResolution(wtPath, entry);
}

/** Re-resolve a subscribed worktree's toolchain now, e.g. after its choice changed. */
export function refreshRustToolchain(worktreePath: string): void {
  const wtPath = path.resolve(worktreePath);
  const entry = worktreeToolchains.get(wtPath);
  if (entry) startResolution(wtPath, entry);
}

/** Login-shell variables that resolution reads, directly or through rustup. */
const RESOLUTION_ENV_VAR = /^(PATH|HOME|CARGO_HOME|RUSTUP_.*)$/;

/**
 * Re-resolve every subscribed worktree that has resolved, e.g. after the login-shell environment
 * was captured again. With `changedNames`, only when one of them can change a resolution: some
 * startup files export values that differ on every run.
 */
export function refreshAllRustToolchains(changedNames?: Iterable<string>): void {
  if (changedNames && !Array.from(changedNames).some((name) => RESOLUTION_ENV_VAR.test(name))) {
    return;
  }
  for (const [wtPath, entry] of worktreeToolchains) {
    if (entry.resolution) startResolution(wtPath, entry);
  }
}

/**
 * Start a re-resolution when the latest one no longer holds: the choice was changed behind the
 * store's change hook, or the repository now tracks the settled toolchain (the trust checks are
 * cached until a git index they read changes, so this is a few `stat` calls otherwise).
 */
async function revalidate(wtPath: string, entry: WorktreeRustToolchain): Promise<void> {
  if (!entry.resolution || worktreeToolchains.get(wtPath) !== entry) return;
  if (getRustChoice(wtPath) !== entry.chosen) {
    startResolution(wtPath, entry);
    return;
  }
  const { settled } = entry;
  if (settled?.toolchain.status !== "active" || entry.withdrawn) return;
  const { rustcPath, sysroot, source } = settled.toolchain;
  // Checked as when it was found: an install without rustup has only its `rustc` checked.
  const root = source === "no-rustup" ? null : sysroot;
  if (!(await isToolchainRepoLocal(wtPath, rustcPath, root))) return;
  // Another caller may have noticed first, or the worktree was unsubscribed meanwhile.
  if (entry.settled !== settled || entry.withdrawn || worktreeToolchains.get(wtPath) !== entry) {
    return;
  }
  entry.withdrawn = true;
  startResolution(wtPath, entry);
}

function startResolution(wtPath: string, entry: WorktreeRustToolchain): Promise<RustToolchain> {
  const env = buildSpawnEnv();
  const chosen = getRustChoice(wtPath);
  const onChange = () => {
    if (worktreeToolchains.get(wtPath) === entry) startResolution(wtPath, entry);
  };
  // Watch the layout before the first resolution so nothing created meanwhile is missed.
  entry.watch ??= watchRustToolchain(wtPath, null, onChange, { env });
  const resolution = resolve(wtPath, chosen, env);
  entry.resolution = resolution;
  entry.chosen = chosen;
  entry.pending = true;
  void resolution.then((toolchain) => {
    if (worktreeToolchains.get(wtPath) !== entry || entry.resolution !== resolution) return;
    const previous = entry.settled;
    entry.settled = { toolchain, chosen };
    entry.pending = false;
    entry.withdrawn = false;
    // Keep the old watch until the new one is armed, and hand a change it saw during resolution
    // to the new one's debounce, so a write burst coalesces into one more round.
    const oldWatch = entry.watch;
    entry.watch = watchRustToolchain(wtPath, toolchain, onChange, { env });
    if (oldWatch?.hasPendingChange) entry.watch.nudge();
    oldWatch?.close();
    const changed =
      !previous ||
      previous.chosen !== chosen ||
      JSON.stringify(previous.toolchain) !== JSON.stringify(toolchain);
    if (changed) log.info("Rust toolchain resolved", { wtPath, status: toolchain.status });
    const update = { toolchain, first: previous === null, changed };
    for (const listener of entry.listeners) {
      // One failing listener must not keep the update from the others.
      try {
        listener(update);
      } catch (err) {
        log.warn("A Rust toolchain listener failed", { wtPath, error: err });
      }
    }
  });
  return resolution;
}

// ---------------------------------------------------------------------------
// Resolution

export interface ResolveRustToolchainOptions {
  /** The toolchain chosen for this worktree. Defaults to the stored choice; null skips it. */
  chosen?: string | null;
  /** Environment for lookups and rustup. Defaults to the login-shell spawn environment. */
  env?: SpawnEnv;
}

/**
 * Find a worktree's Rust toolchain: the choice when it is still installed, else whatever rustup
 * selects for the worktree's directory, else the `rustc` on the login-shell PATH. Runs nothing the
 * worktree holds (see `languages/rust.md`) and never installs anything. Never throws. Uncached;
 * Loxel's features share {@link getRustToolchain} instead.
 */
export async function resolveRustToolchain(
  worktreePath: string,
  options: ResolveRustToolchainOptions = {},
): Promise<RustToolchain> {
  const wtPath = path.resolve(worktreePath);
  const chosen = options.chosen === undefined ? getRustChoice(wtPath) : options.chosen;
  return resolve(wtPath, chosen, options.env ?? buildSpawnEnv());
}

async function resolve(
  wtPath: string,
  chosen: string | null,
  env: SpawnEnv,
): Promise<RustToolchain> {
  try {
    const dirs = searchDirs(env);
    const install = await findInstall(wtPath, dirs);
    if (install.kind === "plain") return await resolvePlain(wtPath, install.rustc, dirs, env);
    if (install.kind === "rustup") {
      return await resolveWithRustup(wtPath, install.rustup, chosen, dirs, env);
    }
    if (install.kind === "unusable") {
      return { status: "none", rustupPath: null, detail: install.detail };
    }
    // It may have been installed since the login shell was captured.
    void refreshLoginShellEnv();
    return { status: "none", rustupPath: null, detail: await shimDetail(dirs) };
  } catch (err) {
    log.warn("Rust toolchain resolution failed", { wtPath, error: err });
    return { status: "none", rustupPath: null, detail: null };
  }
}

/** A Rust installed without rustup: its `rustc` is the toolchain, and there is nothing to choose. */
async function resolvePlain(
  wtPath: string,
  rustcPath: string,
  dirs: string[],
  env: SpawnEnv,
): Promise<RustToolchain> {
  const sysroot = await readSysroot(rustcPath, env);
  const [version, cargo, rustfmt, cargoClippy, rustAnalyzer] = await Promise.all([
    rustVersion(rustcPath, env),
    findTool(wtPath, "cargo", dirs),
    findTool(wtPath, "rustfmt", dirs),
    findTool(wtPath, "cargo-clippy", dirs),
    findTool(wtPath, "rust-analyzer", dirs, { skipProxies: true }),
  ]);
  return {
    status: "active",
    source: "no-rustup",
    name: null,
    version,
    rustcPath,
    sysroot,
    toolchainFile: null,
    tools: { cargo, rustfmt, cargoClippy, rustAnalyzer, rustSrc: hasRustSrc(sysroot) },
  };
}

async function resolveWithRustup(
  wtPath: string,
  rustup: string,
  chosen: string | null,
  dirs: string[],
  env: SpawnEnv,
): Promise<RustToolchain> {
  const refusal = await rustupRefusal(rustup, env);
  if (refusal) return { status: "none", rustupPath: rustup, detail: refusal };

  const installed = chosen === null ? [] : await listInstalled(wtPath, rustup, env);
  // A list that failed says nothing about the choice, which must not silently stop applying.
  if (installed === null) {
    return {
      status: "none",
      rustupPath: rustup,
      detail: "Could not list the installed toolchains",
    };
  }
  const selected = installed.some((choice) => choice.name === chosen) ? chosen : null;
  const rustupEnv = {
    ...env,
    ...RUST_LOXEL_TOOL_ENV,
    ...(selected !== null && { RUSTUP_TOOLCHAIN: selected }),
  };

  // Never `show active-toolchain -v` or `rustup --version` here: they run the selected toolchain's
  // rustc, before anything could check that the repository does not ship it.
  const shown = await runRustup(rustup, ["show", "active-toolchain"], wtPath, rustupEnv);
  const report = parseActiveToolchain(shown.stdout, shown.stderr);
  if (report.kind === "none") return { status: "none", rustupPath: rustup, detail: report.detail };
  const source = selected === null ? report.source : "chosen";
  const { name, toolchainFile } = report;
  if (report.kind === "not-installed") {
    return { status: "not-installed", source, name, toolchainFile };
  }

  const which = await runRustup(rustup, ["which", "rustc"], wtPath, rustupEnv);
  const rustcPath = which.stdout.trim().split("\n")[0]?.trim() ?? "";
  if (which.exitCode !== 0 || !path.isAbsolute(rustcPath)) {
    return { status: "none", rustupPath: rustup, detail: firstError(which.stderr) };
  }
  const sysroot = path.dirname(path.dirname(rustcPath));
  if (await isToolchainRepoLocal(wtPath, rustcPath, sysroot)) {
    log.warn("Ignoring a Rust toolchain that belongs to the worktree", { wtPath, rustcPath });
    return { status: "refused", name, toolchainFile, rustcPath };
  }
  const [version, tools] = await Promise.all([
    rustVersion(rustcPath, env),
    rustupTools(wtPath, rustup, sysroot, dirs, rustupEnv),
  ]);
  return { status: "active", source, name, version, rustcPath, sysroot, toolchainFile, tools };
}

async function rustupTools(
  wtPath: string,
  rustup: string,
  sysroot: string,
  dirs: string[],
  rustupEnv: SpawnEnv,
): Promise<RustTools> {
  const [cargo, rustfmt, cargoClippy, rustAnalyzer] = await Promise.all([
    ...["cargo", "rustfmt", "cargo-clippy"].map((name) =>
      rustupTool(wtPath, Bun.which(name, { PATH: path.join(sysroot, "bin") }), name, dirs),
    ),
    rustupWhich(rustup, "rust-analyzer", wtPath, rustupEnv).then((real) =>
      real
        ? rustupTool(wtPath, real, "rust-analyzer", dirs)
        : findTool(wtPath, "rust-analyzer", dirs, { skipProxies: true }),
    ),
  ]);
  return {
    cargo: cargo ?? null,
    rustfmt: rustfmt ?? null,
    cargoClippy: cargoClippy ?? null,
    rustAnalyzer: rustAnalyzer ?? null,
    rustSrc: hasRustSrc(sysroot),
  };
}

/**
 * A tool of a rustup toolchain, given what the toolchain itself has (the proxy exists whether or not
 * the component is installed, and then only fails): the proxy, which sets up the toolchain's
 * environment for what the tool runs in turn, or else the tool itself.
 */
async function rustupTool(
  wtPath: string,
  real: string | null,
  name: string,
  dirs: string[],
): Promise<string | null> {
  if (!real || (await isRepoLocal(wtPath, real)) || (await isVersionManagerShim(real))) return null;
  return (await findTool(wtPath, name, dirs)) ?? real;
}

/** The tool's path in the worktree's toolchain, or null when the toolchain does not have it. */
async function rustupWhich(
  rustup: string,
  name: string,
  wtPath: string,
  rustupEnv: SpawnEnv,
): Promise<string | null> {
  const { exitCode, stdout } = await runRustup(rustup, ["which", name], wtPath, rustupEnv);
  const found = stdout.trim().split("\n")[0]?.trim() ?? "";
  return exitCode === 0 && path.isAbsolute(found) ? found : null;
}

/** Where the standard library's sources are, in rustup's `rust-src` and in distro packages. */
function hasRustSrc(sysroot: string | null): boolean {
  return sysroot !== null && isDirectory(path.join(sysroot, "lib/rustlib/src/rust/library"));
}

/** The toolchains the user can choose for a worktree; empty without rustup. Never throws. */
export async function listRustToolchains(
  worktreePath: string,
  options: Pick<ResolveRustToolchainOptions, "env"> = {},
): Promise<RustToolchainChoice[]> {
  const env = options.env ?? buildSpawnEnv();
  const wtPath = path.resolve(worktreePath);
  try {
    const install = await findInstall(wtPath, searchDirs(env));
    if (install.kind !== "rustup" || (await rustupRefusal(install.rustup, env))) return [];
    return (await listInstalled(wtPath, install.rustup, env)) ?? [];
  } catch (err) {
    log.warn("Listing Rust toolchains failed", { wtPath, error: err });
    return [];
  }
}

/**
 * The installed toolchains the toolchain rule lets Loxel run (one linked with `rustup toolchain link`
 * can be a directory of a repository). Asked from the filesystem root, where no toolchain file
 * selects anything. Null when rustup could not list them.
 */
async function listInstalled(
  wtPath: string,
  rustup: string,
  env: SpawnEnv,
): Promise<RustToolchainChoice[] | null> {
  const listed = await runRustup(rustup, ["toolchain", "list", "-v"], path.parse(wtPath).root, {
    ...env,
    ...RUST_LOXEL_TOOL_ENV,
  });
  if (listed.exitCode !== 0) return null;
  const choices = await Promise.all(
    parseToolchainList(listed.stdout).map(async ({ name, path: root }) => {
      const rustc = path.join(root, "bin", "rustc");
      if (await isToolchainRepoLocal(wtPath, rustc, root)) return null;
      return { name, path: root, version: await rustVersion(rustc, env) };
    }),
  );
  return choices.filter((choice) => choice !== null);
}

// ---------------------------------------------------------------------------
// Reading rustup's output, which has no JSON form

type ActiveToolchainReport =
  | { kind: "active" | "not-installed"; name: string; source: Source; toolchainFile: string | null }
  | { kind: "none"; detail: string | null };

type Source = Exclude<RustToolchainSource, "chosen" | "no-rustup">;

/**
 * Read `rustup show active-toolchain`: `<name> (<why>)` on stdout, or on stderr an error that names
 * an uninstalled toolchain, or some other error. Whatever else it prints reports no toolchain, with
 * rustup's own words when it gave any.
 */
export function parseActiveToolchain(stdout: string, stderr: string): ActiveToolchainReport {
  const missing = /^error: override toolchain '([^']+)' is not installed: (.*)$/m.exec(stderr);
  if (missing) {
    const [, name = "", why = ""] = missing;
    const file = /toolchain file at '(.+)' specifies/.exec(why)?.[1] ?? null;
    return { kind: "not-installed", name, ...sourceOf(why, file) };
  }
  const line = stdout.trim().split("\n")[0]?.trim();
  if (!line) {
    const detail = firstError(stderr);
    return { kind: "none", detail: detail === "no active toolchain" ? null : detail };
  }
  // The last known reason first, since a path toolchain's name can hold parentheses.
  const shown =
    /^(.+) \((default|overridden by .+|directory override for .+)\)$/.exec(line) ??
    /^(.+?) \((.*)\)$/.exec(line);
  if (!shown) return { kind: "active", name: line, source: "unknown", toolchainFile: null };
  const [, name = "", why = ""] = shown;
  const file = /^overridden by '(.+)'$/.exec(why)?.[1] ?? null;
  return { kind: "active", name, ...sourceOf(why, file) };
}

function sourceOf(
  why: string,
  file: string | null,
): { source: Source; toolchainFile: string | null } {
  if (file) return { source: "toolchain-file", toolchainFile: file };
  const source: Source = why.includes("RUSTUP_TOOLCHAIN")
    ? "environment"
    : why.includes("directory override")
      ? "directory-override"
      : why.includes("default")
        ? "default"
        : "unknown";
  return { source, toolchainFile: null };
}

/** Read `rustup toolchain list -v`: `<name> [(<flags>)] <path>`, skipping any other line. */
export function parseToolchainList(stdout: string): Array<{ name: string; path: string }> {
  return stdout.split("\n").flatMap((line) => {
    const [, name, root] = /^(\S+)(?: \([^)]*\))? (.+)$/.exec(line.trim()) ?? [];
    return name && root && path.isAbsolute(root) ? [{ name, path: root }] : [];
  });
}

function firstError(stderr: string): string | null {
  const line = stderr.split("\n").find((text) => text.trim() !== "");
  return line ? line.replace(/^error: /, "").trim() : null;
}

// ---------------------------------------------------------------------------
// Running things

async function runCommand(
  command: string[],
  cwd: string,
  env: SpawnEnv,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  try {
    const proc = Bun.spawn(command, {
      cwd,
      env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      timeout: COMMAND_TIMEOUT_MS,
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { exitCode, stdout, stderr };
  } catch (err) {
    log.debug("A Rust toolchain command failed to run", { command, error: err });
    return { exitCode: -1, stdout: "", stderr: "" };
  }
}

function runRustup(rustup: string, args: string[], cwd: string, env: SpawnEnv) {
  return runCommand([rustup, ...args], cwd, env);
}

/** A cached answer per file and what else it depends on, until the file changes. */
async function fileKey(filePath: string, extra = ""): Promise<string | null> {
  try {
    const info = await stat(filePath);
    return `${filePath}\0${info.dev}:${info.ino}:${info.mtimeMs}:${info.size}\0${extra}`;
  } catch {
    return null;
  }
}

const versions = new Map<string, Promise<string | null>>();

/**
 * The version of a `rustc` (`1.99.1`), or null when it cannot be read. Cached until the file
 * changes; failures are not cached. Only pass one that passed {@link isRepoLocal}: this executes
 * the file. Runs from the filesystem root, so a version-manager shim on `PATH` reads nothing of the
 * worktree's; such a shim reports its global version.
 */
async function rustVersion(rustcPath: string, env: SpawnEnv): Promise<string | null> {
  const key = await fileKey(rustcPath);
  if (!key) return null;
  let version = versions.get(key);
  if (!version) {
    version = runCommand([rustcPath, "--version"], path.parse(rustcPath).root, {
      ...env,
      ...RUST_LOXEL_TOOL_ENV,
    }).then(({ stdout }) => /^rustc (\S+)/m.exec(stdout)?.[1] ?? null);
    versions.set(key, version);
    void version.then((read) => {
      if (read === null) versions.delete(key);
    });
  }
  return version;
}

async function readSysroot(rustcPath: string, env: SpawnEnv): Promise<string | null> {
  const { exitCode, stdout } = await runCommand(
    [rustcPath, "--print", "sysroot"],
    path.parse(rustcPath).root,
    { ...env, ...RUST_LOXEL_TOOL_ENV },
  );
  const sysroot = stdout.trim();
  return exitCode === 0 && path.isAbsolute(sysroot) ? sysroot : null;
}

const rustupVersions = new Map<string, Promise<string | null>>();

/**
 * Why this rustup must not run in a worktree, or null when it may. `RUSTUP_AUTO_INSTALL` exists from
 * 1.28.1 and 1.28.0 installs nothing by itself, but an older rustup installs what a toolchain file
 * pins whatever the variable says, so a version that cannot be read counts against it too. Read once
 * per rustup file; failures are not cached.
 */
async function rustupRefusal(rustup: string, env: SpawnEnv): Promise<string | null> {
  const key = await fileKey(rustup);
  let read = key ? rustupVersions.get(key) : undefined;
  if (!read) {
    read = readRustupVersion(rustup, env);
    if (key) {
      rustupVersions.set(key, read);
      void read.then((version) => {
        if (version === null) rustupVersions.delete(key);
      });
    }
  }
  const version = await read;
  if (version === null) return "Could not read rustup's version, so Loxel does not run it";
  const [major = 0, minor = 0] = version.split(".").map(Number);
  if (major > 1 || (major === 1 && minor >= 28)) return null;
  return `rustup ${version} can install toolchains by itself, so Loxel does not run it. Update it with \`rustup self update\`.`;
}

/**
 * `rustup --version` also runs the active `rustc` to report it, so it is asked with an empty
 * `RUSTUP_HOME`, where nothing is active.
 */
async function readRustupVersion(rustup: string, env: SpawnEnv): Promise<string | null> {
  let emptyHome: string | null = null;
  try {
    emptyHome = await mkdtemp(path.join(tmpdir(), "loxel-rustup-"));
    // Without an inherited `RUSTUP_TOOLCHAIN`, which would select one even there.
    const { RUSTUP_TOOLCHAIN: _toolchain, ...inherited } = env;
    const { stdout } = await runRustup(rustup, ["--version"], path.parse(emptyHome).root, {
      ...inherited,
      ...RUST_LOXEL_TOOL_ENV,
      RUSTUP_HOME: emptyHome,
    });
    return /^rustup (\d+\.\d+\S*)/m.exec(stdout)?.[1] ?? null;
  } catch (err) {
    log.debug("Could not read the rustup version", { rustup, error: err });
    return null;
  } finally {
    if (emptyHome) await rm(emptyHome, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Finding tools, under the toolchain rule

/** PATH, then `$CARGO_HOME/bin`, then `~/.cargo/bin`: where rustup puts its proxies. */
function searchDirs(env: SpawnEnv): string[] {
  const dirs = (env.PATH ?? "").split(path.delimiter);
  if (env.CARGO_HOME) dirs.push(path.join(env.CARGO_HOME, "bin"));
  dirs.push(path.join(env.HOME ?? homedir(), ".cargo", "bin"));
  return [...new Set(dirs.filter((dir) => path.isAbsolute(dir)))];
}

/**
 * The first usable hit: outside the worktree (see {@link isRepoLocal}) and no version manager's
 * shim, entry by entry, so a refused hit does not hide a real tool later. `skipProxies` is for a tool a rustup proxy may stand for
 * without having it.
 */
async function findTool(
  wtPath: string,
  name: string,
  dirs: string[],
  { skipProxies = false } = {},
): Promise<string | null> {
  for (const dir of pathOutsideWorktree(dirs.join(path.delimiter), wtPath).split(path.delimiter)) {
    const found = dir ? Bun.which(name, { PATH: dir }) : null;
    if (!found || (await isRepoLocal(wtPath, found)) || (await isVersionManagerShim(found))) {
      continue;
    }
    if (skipProxies && (await rustupBehindProxy(found))) continue;
    return found;
  }
  return null;
}

/**
 * Whether a file or directory belongs to the worktree: physically inside it, tracked or not, or
 * shipped by its repository. Nothing that does runs. A path that cannot be read counts.
 */
async function isRepoLocal(wtPath: string, target: string): Promise<boolean> {
  try {
    const [realWorktree, real] = await Promise.all([realpath(wtPath), realpath(target)]);
    if (isInside(real, realWorktree)) return true;
    return await isShippedByRepo(wtPath, target);
  } catch (err) {
    log.debug("Could not check whether a path belongs to the worktree", { target, error: err });
    return true;
  }
}

/** What to say when Rust is on the lookup path only as a version manager's shim. */
async function shimDetail(dirs: string[]): Promise<string | null> {
  for (const dir of dirs) {
    for (const name of ["rustup", "rustc"]) {
      const found = Bun.which(name, { PATH: dir });
      if (found && (await isVersionManagerShim(found))) {
        return `Loxel doesn't run version-manager shims such as ${found}. To use Rust here, install it with rustup: https://rustup.rs`;
      }
    }
  }
  return null;
}

type RustInstall =
  | { kind: "rustup"; rustup: string }
  | { kind: "plain"; rustc: string }
  | { kind: "unusable"; detail: string }
  | { kind: "none" };

/**
 * What answers for the worktree: the `rustc` a terminal would run decides. When it is a rustup proxy
 * it must be treated as rustup whichever `rustup` comes first, since running a proxy in a worktree
 * runs whatever the worktree's toolchain file names.
 */
async function findInstall(wtPath: string, dirs: string[]): Promise<RustInstall> {
  const [rustup, rustc] = await Promise.all([
    findTool(wtPath, "rustup", dirs),
    findTool(wtPath, "rustc", dirs),
  ]);
  if (!rustc) return rustup ? { kind: "rustup", rustup } : { kind: "none" };
  const proxied = await rustupBehindProxy(rustc);
  if (!proxied) return { kind: "plain", rustc };
  if (proxied !== UNKNOWN_RUSTUP && !(await isRepoLocal(wtPath, proxied))) {
    return { kind: "rustup", rustup: proxied };
  }
  return {
    kind: "unusable",
    detail: `${rustc} is a rustup proxy, but no usable rustup is with it`,
  };
}

const UNKNOWN_RUSTUP = Symbol("a rustup proxy whose rustup was not found");

/**
 * The rustup a `rustc` is a proxy of, or null when it is a real compiler. A proxy is a link to
 * rustup, symbolic or hard, normally next to it.
 */
async function rustupBehindProxy(rustc: string): Promise<string | typeof UNKNOWN_RUSTUP | null> {
  const sibling = Bun.which("rustup", { PATH: path.dirname(rustc) });
  if (sibling && (await isSameFile(rustc, sibling))) return sibling;
  const target = await realpath(rustc);
  const name = path.basename(target);
  if (name === "rustup") return target;
  return name.startsWith("rustup") ? UNKNOWN_RUSTUP : null;
}

async function isSameFile(a: string, b: string): Promise<boolean> {
  const [infoA, infoB] = await Promise.all([stat(a), stat(b)]);
  return infoA.dev === infoB.dev && infoA.ino === infoB.ino;
}

/**
 * Whether a toolchain may not run: its compiler, or for a rustup toolchain its whole root, which
 * also holds the tools and libraries it loads, belongs to the worktree. A toolchain file can name
 * one by `path`, and `rustup toolchain link` can install one.
 */
async function isToolchainRepoLocal(
  wtPath: string,
  rustcPath: string,
  sysroot: string | null,
): Promise<boolean> {
  const local = await Promise.all(
    [rustcPath, ...(sysroot ? [sysroot] : [])].map((target) => isRepoLocal(wtPath, target)),
  );
  return local.some(Boolean);
}

// ---------------------------------------------------------------------------
// Watching

/** A live {@link watchRustToolchain} watch. */
export interface RustToolchainWatch {
  close(): void;
  /** True when a change was seen whose debounced `onChange` has not fired yet. */
  readonly hasPendingChange: boolean;
  /** Report a change seen elsewhere, through the same debounce. */
  nudge(): void;
}

export interface WatchRustToolchainOptions {
  /** Environment for `RUSTUP_HOME`. Defaults to none. */
  env?: SpawnEnv;
  debounceMs?: number;
}

/**
 * Call `onChange` (debounced) when the worktree's toolchain may have changed: a toolchain file, a
 * toolchain being installed or removed, the rustup default or a directory override, or a component
 * added to the current toolchain. Watches are non-recursive and fixed to the layout seen now, so
 * callers re-resolve and re-watch on every change; to not lose a change made while re-resolving,
 * keep the old watch until the new one is armed and check its `hasPendingChange` before closing it.
 */
export function watchRustToolchain(
  worktreePath: string,
  current: RustToolchain | null,
  onChange: () => void,
  { env = {}, debounceMs = WATCH_DEBOUNCE_MS }: WatchRustToolchainOptions = {},
): RustToolchainWatch {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      onChange();
    }, debounceMs);
  };

  const watchers: FSWatcher[] = [];
  for (const [dir, names] of watchTargets(path.resolve(worktreePath), current, env)) {
    try {
      const watcher = watch(dir, (_event, filename) => {
        // A null filename means the platform could not say what changed; treat it as relevant.
        if (names === null || filename === null || names.has(filename)) schedule();
      });
      watcher.on("error", (err) => log.debug("Rust toolchain watch failed", { dir, error: err }));
      watchers.push(watcher);
    } catch (err) {
      log.debug("Could not watch for Rust toolchain changes", { dir, error: err });
    }
  }

  return {
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

/** Directories to watch, each with the entry names that matter there (null = every entry). */
function watchTargets(
  wtPath: string,
  current: RustToolchain | null,
  env: SpawnEnv,
): Map<string, Set<string> | null> {
  const targets = new Map<string, Set<string> | null>();
  const add = (dir: string, name: string | null) => {
    const names = targets.get(dir);
    if (names === null) return;
    if (name === null) targets.set(dir, null);
    else if (names) names.add(name);
    else targets.set(dir, new Set([name]));
  };

  for (const name of TOOLCHAIN_FILES) add(wtPath, name);

  const rustupHome = path.resolve(env.RUSTUP_HOME ?? path.join(env.HOME ?? homedir(), ".rustup"));
  const toolchains = path.join(rustupHome, "toolchains");
  if (isDirectory(toolchains)) add(toolchains, null);
  // Not there before rustup's first install: its deepest existing ancestor sees the next segment.
  let missing = toolchains;
  while (!isDirectory(path.dirname(missing)) && path.dirname(missing) !== missing) {
    missing = path.dirname(missing);
  }
  add(path.dirname(missing), path.basename(missing));
  // `rustup default` and `rustup override set` write here.
  if (isDirectory(rustupHome)) add(rustupHome, "settings.toml");

  if (current?.status === "none") {
    // An install that adds no rustup home, such as `brew install rust`.
    for (const dir of searchDirs(env).filter(isDirectory)) {
      add(dir, "rustc");
      add(dir, "rustup");
    }
  }
  if (!current || current.status === "none") return targets;
  // A toolchain file in a parent directory of the worktree.
  if (current.toolchainFile) {
    add(path.dirname(current.toolchainFile), path.basename(current.toolchainFile));
  }
  if (current.status !== "active") return targets;
  // A rust-analyzer installed or removed on its own, with or without rustup.
  const analyzerDirs = current.tools.rustAnalyzer
    ? [path.dirname(current.tools.rustAnalyzer)]
    : searchDirs(env).filter(isDirectory);
  for (const dir of analyzerDirs) add(dir, "rust-analyzer");
  // `rustup component add` and `rustup update` keep the toolchain's directory and write here.
  if (current.sysroot) {
    const rustlib = path.join(current.sysroot, "lib", "rustlib");
    if (isDirectory(rustlib)) add(rustlib, null);
  }
  if (current.source === "no-rustup") {
    for (const name of PLAIN_TOOLS) add(path.dirname(current.rustcPath), name);
  }
  return targets;
}
