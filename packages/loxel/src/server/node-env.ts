import { readdirSync, statSync, watch, type FSWatcher } from "node:fs";
import { access, constants, readdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import type {
  NodeEnv,
  NodeEnvCandidatesResponse,
  NodeEnvResponse,
  NodeInstall,
  NodeManager,
  NodePin,
} from "@/api/node-env-model";
import { isDirectory } from "@/fs-utils";
import { isRecord } from "@/lib/is-record";

import { readConfigFile } from "./config-file-read";
import { logger } from "./logger";
import { getNodeOverride } from "./node-override-store";
import { buildSpawnEnv } from "./shell-env";
import { isShippedByRepo } from "./shipped-by-repo";
import { measureSpawn } from "./spawn-metrics";
import { parseToml, recordAt } from "./toml-file";
import type { SpawnEnv } from "./toolchain-env-contributor";

const log = logger.child("server");

const VERSION_TIMEOUT_MS = 5000;
/** Quiet period after the last filesystem event before re-resolving (installers write in bursts). */
const WATCH_DEBOUNCE_MS = 1000;
/** An installed version's directory name. Aliases (mise's `22`, `latest`) and pre-releases differ. */
const INSTALL_DIR_RE = /^v?(\d+\.\d+\.\d+)$/;
const NODE_OUTPUT_RE = /^v(\d+\.\d+\.\d+\S*)\s*$/;
const LTS_HEADER_RE = /#define NODE_VERSION_LTS_CODENAME "(\w+)"/;
const RELATIVE_NODE = path.join("bin", "node");

// ---------------------------------------------------------------------------
// Pins

/** What the worktree root pins, in precedence order: single-purpose files before shared ones. */
const PIN_READERS: ReadonlyArray<{ file: string; read: (text: string) => string | null }> = [
  { file: ".nvmrc", read: versionFileSpec },
  { file: ".node-version", read: versionFileSpec },
  { file: ".tool-versions", read: toolVersionsSpec },
  { file: "mise.toml", read: miseSpec },
  { file: ".mise.toml", read: miseSpec },
  { file: "package.json", read: voltaSpec },
];

/** The first line with content, without a `#` comment. */
function versionFileSpec(text: string): string | null {
  for (const line of text.split("\n")) {
    const content = line.split("#", 1)[0]!.trim();
    if (content) return content;
  }
  return null;
}

/** The first version of a `nodejs` line, the one asdf and mise put first on `PATH`. */
function toolVersionsSpec(text: string): string | null {
  return /^(?:nodejs|node)[ \t]+(\S+)/m.exec(text)?.[1] ?? null;
}

/** `node` under `[tools]`: a version, a list whose first is the default, or `{ version = ".." }`. */
function miseSpec(text: string): string | null {
  const tools = recordAt(parseToml(text), "tools");
  let value = tools?.node ?? tools?.nodejs;
  if (value === undefined) return null;
  if (Array.isArray(value)) value = value[0];
  if (isRecord(value)) value = value.version;
  return typeof value === "string" ? value : "";
}

function voltaSpec(text: string): string | null {
  try {
    const parsed: unknown = JSON.parse(text);
    const node = recordAt(parsed, "volta")?.node;
    return typeof node === "string" ? node : null;
  } catch {
    return null;
  }
}

/** What a pin asks for. */
type NodeSpec =
  | { kind: "latest" }
  | { kind: "lts"; codename: string | null }
  | { kind: "version"; parts: string[] };

/**
 * Parses a pinned version: `22`, `v22.1`, `22.1.0`, `22.x`, `node`, `latest`, `stable`, `lts`,
 * `lts/*`, `lts/iron`, `lts-iron`. Null for anything else (`lts/-1`, `path:..`, a pre-release),
 * and this grammar is what lets a spec be shown and put in a command for the user to run.
 */
export function parseNodeSpec(raw: string): NodeSpec | null {
  const spec = raw.trim();
  if (["node", "latest", "stable"].includes(spec)) return { kind: "latest" };
  const lts = /^lts(?:[/-](\*|[a-zA-Z]+))?$/.exec(spec);
  if (lts) {
    const name = lts[1];
    return { kind: "lts", codename: !name || name === "*" ? null : name.toLowerCase() };
  }
  const version = /^v?(\d+)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?$/.exec(spec);
  if (!version) return null;
  const parts = version.slice(1).filter((part) => part !== undefined);
  const wildcard = parts.findIndex((part) => part === "x" || part === "*");
  return { kind: "version", parts: wildcard === -1 ? parts : parts.slice(0, wildcard) };
}

/** The pin at the worktree root, first file with one wins; null also for an explicit `system`. */
function readPin(wtPath: string): { file: string; raw: string } | null {
  for (const { file, read } of PIN_READERS) {
    const text = readConfigFile(path.join(wtPath, file));
    const raw = text === undefined ? null : read(text);
    if (raw === null) continue;
    return raw.trim() === "system" ? null : { file, raw };
  }
  return null;
}

/** The LTS line of an installation, from the header it ships, so no list of names goes stale. */
async function ltsCodename(nodePath: string): Promise<string | null> {
  const real = await realpath(nodePath).catch(() => nodePath);
  const header = readConfigFile(path.resolve(real, "../../include/node/node_version.h"));
  return (header && LTS_HEADER_RE.exec(header)?.[1]?.toLowerCase()) || null;
}

async function satisfies(spec: NodeSpec, install: NodeInstall): Promise<boolean> {
  if (spec.kind === "latest") return true;
  if (spec.kind === "lts") {
    const codename = await ltsCodename(install.nodePath);
    return codename !== null && (spec.codename === null || spec.codename === codename);
  }
  const parts = install.version?.split(".");
  return !!parts && spec.parts.every((part, i) => part === parts[i]);
}

// ---------------------------------------------------------------------------
// Installed versions

interface ManagerDir {
  manager: NodeManager;
  /** The directory with one entry per installed version. */
  versionsDir: string;
  /** Where a version's `bin/node` is below its entry. */
  installSubdir: string;
}

/** A directory from a variable, ignored unless absolute. */
function dirFrom(env: SpawnEnv, name: string): string | null {
  const value = env[name];
  return value && path.isAbsolute(value) ? value : null;
}

function managerDirs(env: SpawnEnv): ManagerDir[] {
  const home = env.HOME || homedir();
  const dataHome = dirFrom(env, "XDG_DATA_HOME") ?? path.join(home, ".local", "share");
  const fnmBases = [path.join(dataHome, "fnm"), path.join(home, ".fnm")];
  if (process.platform === "darwin") {
    fnmBases.push(path.join(home, "Library", "Application Support", "fnm"));
  }
  const fnmDir = dirFrom(env, "FNM_DIR");
  const miseData = dirFrom(env, "MISE_DATA_DIR") ?? path.join(dataHome, "mise");
  const nPrefix = dirFrom(env, "N_CACHE_PREFIX") ?? dirFrom(env, "N_PREFIX") ?? "/usr/local";
  const direct = (manager: NodeManager, versionsDir: string): ManagerDir => ({
    manager,
    versionsDir,
    installSubdir: "",
  });
  return [
    direct(
      "nvm",
      path.join(dirFrom(env, "NVM_DIR") ?? path.join(home, ".nvm"), "versions", "node"),
    ),
    ...(fnmDir ? [fnmDir] : fnmBases).map((base) => ({
      manager: "fnm" as const,
      versionsDir: path.join(base, "node-versions"),
      installSubdir: "installation",
    })),
    direct(
      "volta",
      path.join(dirFrom(env, "VOLTA_HOME") ?? path.join(home, ".volta"), "tools", "image", "node"),
    ),
    direct(
      "asdf",
      path.join(dirFrom(env, "ASDF_DATA_DIR") ?? path.join(home, ".asdf"), "installs", "nodejs"),
    ),
    direct(
      "mise",
      path.join(dirFrom(env, "MISE_INSTALLS_DIR") ?? path.join(miseData, "installs"), "node"),
    ),
    direct("n", path.join(nPrefix, "n", "versions", "node")),
  ];
}

function compareVersionsDescending(a: NodeInstall, b: NodeInstall): number {
  const left = (a.version ?? "").split(".").map(Number);
  const right = (b.version ?? "").split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const difference = (right[i] ?? 0) - (left[i] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/**
 * Every version the managers have installed, newest first, read from their directories: the
 * version comes from the directory name, so nothing runs. Not yet checked against the trust rule.
 */
async function installedNodes(env: SpawnEnv): Promise<NodeInstall[]> {
  const perDir = await Promise.all(
    managerDirs(env).map(async ({ manager, versionsDir, installSubdir }) => {
      const names = await readdir(versionsDir).catch(() => [] as string[]);
      const installs = await Promise.all(
        names.map(async (name): Promise<NodeInstall | null> => {
          const version = INSTALL_DIR_RE.exec(name)?.[1];
          if (!version) return null;
          const nodePath = path.join(versionsDir, name, installSubdir, RELATIVE_NODE);
          return (await isExecutable(nodePath)) ? { nodePath, version, manager } : null;
        }),
      );
      return installs.filter((install) => install !== null);
    }),
  );
  return perDir.flat().sort(compareVersionsDescending);
}

async function isExecutable(filePath: string): Promise<boolean> {
  try {
    await access(filePath, constants.X_OK);
    return statSync(filePath).isFile();
  } catch {
    return false;
  }
}

/**
 * `node --version`, for a `node` no manager's directory explains. Asked from the home directory:
 * a version-manager shim answers for the directory it runs in, by acting on what that directory's
 * files say, which can include downloading a pinned version. Pins were matched before this, so
 * what is left to learn is the user's own default. A real `node` answers the same anywhere.
 */
async function readNodeVersion(nodePath: string, env: SpawnEnv): Promise<string | null> {
  try {
    const proc = measureSpawn("node-version", () =>
      Bun.spawn([nodePath, "--version"], {
        cwd: env.HOME || homedir(),
        env: { ...env, MISE_NOT_FOUND_AUTO_INSTALL: "0" },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "ignore",
        timeout: VERSION_TIMEOUT_MS,
      }),
    );
    const [stdout] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    return NODE_OUTPUT_RE.exec(stdout)?.[1] ?? null;
  } catch (err) {
    log.debug("Could not read the Node version", { nodePath, error: err });
    return null;
  }
}

/**
 * A `node` as an install: the manager's entry it resolves to (fnm's `PATH` entry is a symlink that
 * lasts one shell), else what it says it is.
 */
async function describeNode(
  nodePath: string,
  installs: readonly NodeInstall[],
  env: SpawnEnv,
): Promise<NodeInstall> {
  const real = await realpath(nodePath).catch(() => nodePath);
  for (const install of installs) {
    if ((await realpath(install.nodePath).catch(() => install.nodePath)) === real) {
      return install;
    }
  }
  return { nodePath, version: await readNodeVersion(nodePath, env), manager: null };
}

/** The first `node` on the login-shell `PATH` that git does not track, entry by entry. */
async function pathNode(wtPath: string, env: SpawnEnv): Promise<string | null> {
  for (const dir of (env.PATH ?? "").split(path.delimiter)) {
    // A relative entry would mean something else in every directory.
    if (!path.isAbsolute(dir)) continue;
    const found = Bun.which("node", { PATH: dir });
    if (found && !(await isShippedByRepo(wtPath, found))) return found;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Resolution

/** How each manager spells an install; `codename` is null when it has no form for one. */
const INSTALL_FORMS: Record<
  NodeManager,
  {
    command: string;
    latest: string;
    lts: string;
    codename: ((name: string) => string) | null;
    version: (parts: readonly string[]) => string;
  }
> = {
  nvm: {
    command: "nvm install ",
    latest: "node",
    lts: "--lts",
    codename: (name) => `lts/${name}`,
    version: (parts) => parts.join("."),
  },
  fnm: {
    command: "fnm install ",
    latest: "--latest",
    lts: "--lts",
    codename: (name) => `lts/${name}`,
    version: (parts) => parts.join("."),
  },
  mise: {
    command: "mise install node@",
    latest: "latest",
    lts: "lts",
    codename: (name) => `lts-${name}`,
    version: (parts) => parts.join("."),
  },
  asdf: {
    command: "asdf install nodejs ",
    latest: "latest",
    lts: "lts",
    codename: (name) => `lts-${name}`,
    // asdf installs only exact versions, unless asked for the latest of a line.
    version: (parts) => (parts.length === 3 ? parts.join(".") : `latest:${parts.join(".")}`),
  },
  volta: {
    command: "volta install node@",
    latest: "latest",
    lts: "lts",
    codename: null,
    version: (parts) => parts.join("."),
  },
  n: {
    command: "n install ",
    latest: "latest",
    lts: "lts",
    codename: (name) => name,
    version: (parts) => parts.join("."),
  },
};

function installCommand(manager: NodeManager, spec: NodeSpec): string | null {
  const form = INSTALL_FORMS[manager];
  if (spec.kind === "version") return form.command + form.version(spec.parts);
  if (spec.kind === "latest") return form.command + form.latest;
  if (spec.codename === null) return form.command + form.lts;
  return form.codename && form.command + form.codename(spec.codename);
}

/** The manager each pin file belongs to first; any other manager the user has comes after. */
const PIN_FILE_MANAGERS: Record<string, readonly NodeManager[]> = {
  ".nvmrc": ["nvm", "fnm"],
  ".node-version": ["fnm", "nvm"],
  ".tool-versions": ["asdf", "mise"],
  "mise.toml": ["mise"],
  ".mise.toml": ["mise"],
  "package.json": ["volta"],
};
const ALL_MANAGERS = Object.keys(INSTALL_FORMS) as NodeManager[];

/**
 * What to tell the user about a pin nothing installed satisfies. Loxel never installs a version
 * itself: this names the command for a manager the user has, or an example when they have none.
 */
function missingPinMessage(pin: NodePin, spec: NodeSpec, env: SpawnEnv): string {
  const order = [...new Set([...(PIN_FILE_MANAGERS[pin.file] ?? []), ...ALL_MANAGERS])];
  const dirs = managerDirs(env);
  const present = order.filter((manager) =>
    dirs.some((dir) => dir.manager === manager && isDirectory(dir.versionsDir)),
  );
  const usable = (managers: readonly NodeManager[]) =>
    managers.map((manager) => installCommand(manager, spec)).find(Boolean);
  const command = usable(present);
  const advice = command
    ? `Run \`${command}\` in a terminal.`
    : `Install it with a version manager, for example \`${usable(order) ?? ""}\` in a terminal.`;
  return `${pin.file} pins ${pin.spec}, which is not installed. ${advice}`;
}

export interface ResolveNodeEnvOptions {
  /** `node` chosen for this worktree. Defaults to the stored one; null skips any override. */
  overridePath?: string | null;
  /** Environment for `PATH` and the managers' variables. Defaults to the login-shell one. */
  env?: SpawnEnv;
}

/**
 * Finds the Node for a worktree, first hit wins: the chosen override; the root's pin, matched
 * against what the managers have installed (a partial pin takes the highest match); `node` on the
 * login-shell `PATH`. Anything git tracks does not count. A pin that nothing satisfies, the `PATH`
 * `node` included, falls back to `PATH` and reports `pinProblem`. Never throws. Uncached; Loxel's
 * features share {@link getNodeEnv} instead.
 */
export async function resolveNodeEnv(
  worktreePath: string,
  options: ResolveNodeEnvOptions = {},
): Promise<NodeEnvResponse> {
  const env = options.env ?? buildSpawnEnv();
  const wtPath = path.resolve(worktreePath);
  const overridePath =
    options.overridePath === undefined ? getNodeOverride(wtPath) : options.overridePath;
  const installs = await installedNodes(env);
  const pinned = readPin(wtPath);
  const spec = pinned && parseNodeSpec(pinned.raw);
  const pin = pinned && spec ? { file: pinned.file, spec: pinned.raw.trim() } : null;
  const answer = (found: NodeEnv | null, pinProblem: string | null = null): NodeEnvResponse => ({
    env: found,
    pin,
    pinProblem,
    overridePath,
  });

  if (
    overridePath &&
    (await isExecutable(overridePath)) &&
    !(await isShippedByRepo(wtPath, overridePath))
  ) {
    return answer({ ...(await describeNode(overridePath, installs, env)), source: "override" });
  }

  if (spec) {
    for (const install of installs) {
      if ((await satisfies(spec, install)) && !(await isShippedByRepo(wtPath, install.nodePath))) {
        return answer({ ...install, source: "pin" });
      }
    }
  }

  const found = await pathNode(wtPath, env);
  const system = found ? await describeNode(found, installs, env) : null;
  const systemEnv: NodeEnv | null = system && { ...system, source: "system" };
  if (!pinned) return answer(systemEnv);
  if (!spec || !pin) {
    return answer(systemEnv, `${pinned.file} holds a Node version Loxel cannot read.`);
  }
  if (system && (await satisfies(spec, system))) return answer(systemEnv);
  return answer(systemEnv, missingPinMessage(pin, spec, env));
}

/**
 * What the user can choose for a worktree: every installed version git does not track, newest
 * first, then the `node` on `PATH` unless it is one of those.
 */
export async function listNodeEnvs(worktreePath: string): Promise<NodeEnvCandidatesResponse> {
  const env = buildSpawnEnv();
  const wtPath = path.resolve(worktreePath);
  const installs = await installedNodes(env);
  const shipped = await Promise.all(
    installs.map((install) => isShippedByRepo(wtPath, install.nodePath)),
  );
  const candidates = installs.filter((_, i) => !shipped[i]);
  const found = await pathNode(wtPath, env);
  const system = found ? await describeNode(found, candidates, env) : null;
  if (system && system.manager === null) candidates.push(system);
  const automatic = await resolveNodeEnv(wtPath, { overridePath: null, env });
  return {
    candidates,
    automaticPath: automatic.env?.nodePath ?? null,
    overridePath: getNodeOverride(wtPath),
  };
}

// ---------------------------------------------------------------------------
// The shared, memoized resolution per worktree

/** What a {@link subscribeNodeEnv} listener hears after each finished resolution. */
export interface NodeEnvUpdate {
  env: NodeEnv | null;
  /** Anything the status item shows differs from the previous resolution's. */
  changed: boolean;
}

interface WorktreeNodeEnv {
  listeners: Set<(update: NodeEnvUpdate) => void>;
  /** The latest resolution, finished or not; null until something asks for it. */
  resolution: Promise<NodeEnvResponse> | null;
  settled: NodeEnvResponse | null;
  /** The override the latest resolution started with. */
  overridePath: string | null;
  watch: NodeEnvWatch | null;
}

const worktreeEnvs = new Map<string, WorktreeNodeEnv>();

/**
 * Keep the worktree's resolution memoized and watched while subscribed, and call `listener` after
 * each one finishes. Subscribing resolves nothing by itself; the first {@link getNodeEnv} does.
 * Returns the unsubscribe function; the memo and its watch go with the last subscriber.
 */
export function subscribeNodeEnv(
  worktreePath: string,
  listener: (update: NodeEnvUpdate) => void,
): () => void {
  const wtPath = path.resolve(worktreePath);
  let entry = worktreeEnvs.get(wtPath);
  if (!entry) {
    entry = {
      listeners: new Set(),
      resolution: null,
      settled: null,
      overridePath: null,
      watch: null,
    };
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
 * The worktree's Node (see {@link resolveNodeEnv}), shared by every caller: memoized while the
 * worktree is subscribed, and resolved afresh without a subscriber, since nothing would keep a memo
 * current. Starts over when the override changed or the repository now tracks the settled `node`.
 */
export async function getNodeEnv(worktreePath: string): Promise<NodeEnvResponse> {
  const wtPath = path.resolve(worktreePath);
  const entry = worktreeEnvs.get(wtPath);
  if (!entry) return resolveNodeEnv(wtPath);
  const settledPath = entry.settled?.env?.nodePath;
  const stale =
    entry.resolution !== null &&
    (getNodeOverride(wtPath) !== entry.overridePath ||
      (settledPath !== undefined && (await isShippedByRepo(wtPath, settledPath))));
  // Unsubscribed meanwhile: nothing would close a watch armed for it now.
  if (worktreeEnvs.get(wtPath) !== entry) return resolveNodeEnv(wtPath);
  return stale
    ? startResolution(wtPath, entry)
    : (entry.resolution ?? startResolution(wtPath, entry));
}

/** Re-resolve a subscribed worktree's Node now, e.g. after its override changed. */
export function refreshNodeEnv(worktreePath: string): void {
  const wtPath = path.resolve(worktreePath);
  const entry = worktreeEnvs.get(wtPath);
  if (entry) startResolution(wtPath, entry);
}

/** Login-shell variables that resolution reads. */
const RESOLUTION_ENV_VAR =
  /^(PATH|HOME|XDG_DATA_HOME|NVM_DIR|FNM_DIR|VOLTA_HOME|ASDF_DATA_DIR|MISE_DATA_DIR|MISE_INSTALLS_DIR|N_PREFIX|N_CACHE_PREFIX)$/;

/** Re-resolve every subscribed worktree that has resolved, when one of these variables changed. */
export function refreshAllNodeEnvs(changedNames: Iterable<string>): void {
  if (!Array.from(changedNames).some((name) => RESOLUTION_ENV_VAR.test(name))) return;
  for (const [wtPath, entry] of worktreeEnvs) {
    if (entry.resolution) startResolution(wtPath, entry);
  }
}

function startResolution(wtPath: string, entry: WorktreeNodeEnv): Promise<NodeEnvResponse> {
  const env = buildSpawnEnv();
  const overridePath = getNodeOverride(wtPath);
  const onChange = () => {
    if (worktreeEnvs.get(wtPath) === entry) startResolution(wtPath, entry);
  };
  // Watch before the first resolution so nothing created meanwhile is missed.
  entry.watch ??= watchNodeEnv(wtPath, null, onChange, env);
  const resolution = resolveNodeEnv(wtPath, { overridePath, env });
  entry.resolution = resolution;
  entry.overridePath = overridePath;
  void resolution.then((resolved) => {
    if (worktreeEnvs.get(wtPath) !== entry || entry.resolution !== resolution) return;
    const changed = JSON.stringify(entry.settled) !== JSON.stringify(resolved);
    entry.settled = resolved;
    // Keep the old watch until the new one is armed, and hand a change it saw during resolution
    // to the new one's debounce, so a write burst coalesces into one more round.
    const oldWatch = entry.watch;
    entry.watch = watchNodeEnv(wtPath, resolved.env, onChange, env);
    if (oldWatch?.hasPendingChange) entry.watch.nudge();
    oldWatch?.close();
    if (changed) {
      log.info("Node version resolved", {
        wtPath,
        source: resolved.env?.source ?? null,
        nodePath: resolved.env?.nodePath ?? null,
      });
    }
    for (const listener of entry.listeners) {
      // One failing listener must not keep the update from the others.
      try {
        listener({ env: resolved.env, changed });
      } catch (err) {
        log.warn("A Node version listener failed", { wtPath, error: err });
      }
    }
  });
  return resolution;
}

// ---------------------------------------------------------------------------
// Watching

interface NodeEnvWatch {
  close(): void;
  /** True when a change was seen whose debounced `onChange` has not fired yet. */
  readonly hasPendingChange: boolean;
  /** Report a change seen elsewhere, through the same debounce. */
  nudge(): void;
}

/**
 * Call `onChange` (debounced) when the worktree's Node may have changed: a pin file at its root
 * changing, a manager installing or removing a version, a `node` appearing on `PATH`, or the
 * current `node` being replaced. The
 * watches are non-recursive and fixed to the layout seen now, so callers re-resolve and re-watch.
 */
function watchNodeEnv(
  wtPath: string,
  current: NodeEnv | null,
  onChange: () => void,
  env: SpawnEnv,
): NodeEnvWatch {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      onChange();
    }, WATCH_DEBOUNCE_MS);
  };
  const watchers: FSWatcher[] = [];
  for (const [dir, names] of watchTargets(wtPath, current, env)) {
    try {
      const watcher = watch(dir, (_event, filename) => {
        // A null filename means the platform could not say what changed; treat it as relevant.
        if (names === null || filename === null || names.has(filename)) schedule();
      });
      watcher.on("error", (err) => log.debug("Node version watch failed", { dir, error: err }));
      watchers.push(watcher);
    } catch (err) {
      log.debug("Could not watch for Node version changes", { dir, error: err });
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

/**
 * Directories to watch, each with the entry names that matter there (null = every entry). A
 * manager without its versions directory yet is watched at the deepest ancestor that exists, for
 * the next path segment. Some managers fill a version's directory in place after creating it, so
 * an entry without its `node` yet is watched too.
 */
function watchTargets(
  wtPath: string,
  current: NodeEnv | null,
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
  for (const { file } of PIN_READERS) add(wtPath, file);
  for (const { versionsDir, installSubdir } of managerDirs(env)) {
    if (isDirectory(versionsDir)) {
      add(versionsDir, null);
      for (const dir of unfinishedInstallDirs(versionsDir, installSubdir)) add(dir, null);
      continue;
    }
    let missing = versionsDir;
    while (!isDirectory(path.dirname(missing)) && path.dirname(missing) !== missing) {
      missing = path.dirname(missing);
    }
    add(path.dirname(missing), path.basename(missing));
  }
  for (const dir of (env.PATH ?? "").split(path.delimiter)) {
    if (path.isAbsolute(dir) && isDirectory(dir)) add(dir, "node");
  }
  if (current) add(path.dirname(current.nodePath), path.basename(current.nodePath));
  return targets;
}

function unfinishedInstallDirs(versionsDir: string, installSubdir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(versionsDir);
  } catch {
    return [];
  }
  return names
    .filter((name) => INSTALL_DIR_RE.test(name))
    .map((name) => path.join(versionsDir, name, installSubdir))
    .filter((dir) => {
      try {
        statSync(path.join(dir, RELATIVE_NODE));
        return false;
      } catch {
        return true;
      }
    })
    .flatMap((dir) => [dir, path.join(dir, "bin")])
    .filter((dir) => isDirectory(dir));
}
