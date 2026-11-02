import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { RustToolchain, RustToolchainSource } from "@/api/rust-toolchain-model";
import { isRecord } from "@/lib/is-record";

import { logger } from "./logger";
import { pathOutsideWorktree } from "./python-env";
import { isReadableRustManifest, RUST_MANIFEST, untrustedNestedRepo } from "./rust-project-lookup";
import { rustToolEnv } from "./rust-toolchain";
import { buildSpawnEnv } from "./shell-env";

const log = logger.child("rust-lsp");

const COMMAND_TIMEOUT_MS = 10_000;
/** A manifest's check reads one file, but on a loaded machine a refusal is worse than a wait. */
const MANIFEST_CHECK_TIMEOUT_MS = 30_000;

/**
 * The oldest rust-analyzer Loxel starts, by the date in its version. Older ones are not known to
 * honor the settings the restricted mode rests on. Trust does not lower it: what keeps a trusted
 * server from installing anything rests on settings as well (`cargo.sysroot`).
 */
export const MIN_RUST_ANALYZER_DATE = "2025-01-07";

/** The inline project for a worktree without a manifest: nothing is looked for on disk instead. */
const NO_PROJECT = { sysroot: null, crates: [] };

/** The edition of a file outside any package: the newest the oldest supported server accepts. */
const LOOSE_FILE_EDITION = "2024";

/** What a server whose toolchain has them finds the standard library's sources under. */
const SYSROOT_LIBRARY = "lib/rustlib/src/rust/library";

/** What expands proc macros, in the toolchain the macros were compiled with. */
const SYSROOT_PROC_MACRO_SERVER = "libexec/rust-analyzer-proc-macro-srv";

/** Where a toolchain named by path is the user's own doing, and not a file in the repository. */
const USER_SELECTED_SOURCES: ReadonlySet<RustToolchainSource> = new Set([
  "chosen",
  "default",
  "directory-override",
  "environment",
]);

/** A toolchain name safe to print as part of a command to run; it can come from a repository. */
const PLAIN_TOOLCHAIN_NAME = /^[\w.+-]+$/;

/** How to start rust-analyzer for a worktree, or why it does not start. */
export type RustAnalyzerPlan =
  | {
      kind: "run";
      binary: string;
      cargo: string;
      env: Record<string, string>;
      sysroot: string;
      /** The compiler's own target, the one analyzed. */
      host: string;
      /** The toolchain has the standard library's sources. */
      rustSrc: boolean;
      /** Whether the repository's code may run: decides the settings and the environment. */
      repoTrusted: boolean;
      /** What a trusted server checks with: clippy, where the toolchain has it. */
      checkCommand: "check" | "clippy";
      /** Whether two plans run the same thing; a different one calls for a restart. */
      key: string;
    }
  | { kind: "refuse"; reason: string };

type RunPlan = Extract<RustAnalyzerPlan, { kind: "run" }>;

function refuse(reason: string): RustAnalyzerPlan {
  return { kind: "refuse", reason };
}

/** What to do about a toolchain nothing can run from. Each reason fits a WebSocket close frame. */
function unusableReason(toolchain: Exclude<RustToolchain, { status: "active" }>): string {
  if (toolchain.status === "not-installed") {
    return PLAIN_TOOLCHAIN_NAME.test(toolchain.name)
      ? `The selected Rust toolchain is not installed. Run: rustup toolchain install ${toolchain.name}`
      : "The selected Rust toolchain is not installed.";
  }
  if (toolchain.status === "refused") {
    return "The repository selects its own Rust toolchain. Pick an installed one: Rust: Select Toolchain";
  }
  return toolchain.rustupPath
    ? "rustup has no usable toolchain. Run: rustup default stable"
    : "Rust was not found. Install it from https://rustup.rs";
}

async function capture(
  command: string[],
  cwd: string,
  env: Record<string, string | undefined>,
): Promise<string | null> {
  try {
    const proc = Bun.spawn(command, {
      cwd,
      env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
      timeout: COMMAND_TIMEOUT_MS,
    });
    const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    return exitCode === 0 ? stdout : null;
  } catch {
    return null;
  }
}

/** The date in `rust-analyzer --version`, the one thing every kind of build reports. */
export function rustAnalyzerDate(versionOutput: string): string | null {
  return /\b(\d{4}-\d{2}-\d{2})\b/.exec(versionOutput)?.[1] ?? null;
}

function fileStamp(file: string): string {
  try {
    const info = statSync(file);
    return `${info.dev}:${info.ino}:${info.mtimeMs}:${info.size}`;
  } catch {
    return "";
  }
}

/**
 * The variables a session runs with. In both modes it stays on the resolved toolchain and installs
 * nothing: `RUSTUP_TOOLCHAIN` beats a toolchain file for every proxy the server starts,
 * `RUSTUP_AUTO_INSTALL` and the `CARGO_NET_*` pair keep rustup and cargo from fetching, `PATH` holds
 * no worktree entries, and `CARGO` is the cargo the server asks.
 *
 * Untrusted, the rest takes every tool setting away from cargo's configuration files, which cargo
 * reads even for `cargo metadata`. Trusted, those files mean what they mean by hand, wrappers, flags
 * and target included, so these stay unset. So does `RUSTC`, which beats `build.rustc`, except without
 * a rustup toolchain: then no proxy finds the compiler, which the lookup may have found off `PATH`.
 */
export function rustAnalyzerEnv(
  toolchain: Extract<RustToolchain, { status: "active" }>,
  cargo: string,
  inheritedPath: string,
  wtPath: string,
  repoTrusted: boolean,
): Record<string, string> {
  const pinned = {
    ...rustToolEnv(toolchain),
    ...(toolchain.name && { RUSTUP_TOOLCHAIN: toolchain.name }),
    PATH: pathOutsideWorktree(inheritedPath, wtPath),
    CARGO: cargo,
    CARGO_NET_OFFLINE: "true",
    CARGO_NET_GIT_FETCH_WITH_CLI: "false",
  };
  if (repoTrusted) return { ...pinned, ...(!toolchain.name && { RUSTC: toolchain.rustcPath }) };
  return {
    ...pinned,
    RUSTC: toolchain.rustcPath,
    RUSTC_WRAPPER: "",
    RUSTC_WORKSPACE_WRAPPER: "",
    CARGO_ENCODED_RUSTFLAGS: "",
    CARGO_ENCODED_RUSTDOCFLAGS: "",
    CARGO_TARGET_APPLIES_TO_HOST: "true",
    CARGO_UNSTABLE_HOST_CONFIG: "false",
  };
}

/**
 * Decide how to start rust-analyzer for a worktree's toolchain. Everything run here runs from the
 * filesystem root with the toolchain pinned, so it answers for the binary the session will run and
 * no file in the worktree selects anything.
 */
export async function planRustAnalyzer(
  wtPath: string,
  toolchain: RustToolchain,
  repoTrusted: boolean,
): Promise<RustAnalyzerPlan> {
  if (toolchain.status !== "active") return refuse(unusableReason(toolchain));
  // A toolchain file's `path`: outside the worktree, but still the repository's pick of a binary.
  // Anything but a source known to be the user's counts, also one rustup's wording hid.
  if (path.isAbsolute(toolchain.name ?? "") && !USER_SELECTED_SOURCES.has(toolchain.source)) {
    return refuse(
      "The repository selects a Rust toolchain by path. Pick an installed one: Rust: Select Toolchain",
    );
  }
  const { rustAnalyzer, cargo, cargoClippy, rustSrc } = toolchain.tools;
  if (!rustAnalyzer) {
    return refuse(
      toolchain.name
        ? `rust-analyzer is missing. Run: rustup component add rust-analyzer --toolchain ${toolchain.name}`
        : "rust-analyzer was not found. Install it to get language features for Rust.",
    );
  }
  if (!cargo) return refuse("cargo was not found in this Rust toolchain.");
  if (!toolchain.sysroot) return refuse("Could not find this Rust toolchain's root.");

  const spawnEnv = buildSpawnEnv();
  const root = path.parse(rustAnalyzer).root;
  const pinned = {
    ...spawnEnv,
    ...rustToolEnv(toolchain),
    ...(toolchain.name && { RUSTUP_TOOLCHAIN: toolchain.name }),
  };
  const version = await capture([rustAnalyzer, "--version"], root, pinned);
  const date = version === null ? null : rustAnalyzerDate(version);
  if (date === null)
    return refuse("Could not read rust-analyzer's version, so it was not started.");
  if (date < MIN_RUST_ANALYZER_DATE) {
    return refuse(
      `This rust-analyzer (${date}) is too old for Loxel. Update it, or pick a newer toolchain.`,
    );
  }
  const compiler = await capture([toolchain.rustcPath, "-vV"], root, pinned);
  const host = compiler === null ? null : /^host: (\S+)$/m.exec(compiler)?.[1];
  if (!host) return refuse("Could not read the Rust compiler's host target.");
  const checkCommand = cargoClippy ? "clippy" : "check";

  return {
    kind: "run",
    binary: rustAnalyzer,
    cargo,
    env: rustAnalyzerEnv(toolchain, cargo, spawnEnv.PATH ?? "", wtPath, repoTrusted),
    sysroot: toolchain.sysroot,
    host,
    rustSrc,
    repoTrusted,
    checkCommand,
    key: JSON.stringify([
      rustAnalyzer,
      fileStamp(rustAnalyzer),
      version,
      toolchain.name,
      toolchain.rustcPath,
      toolchain.version,
      cargo,
      toolchain.sysroot,
      rustSrc,
      // A restricted server runs no check, so a new clippy is no reason to restart it.
      repoTrusted && checkCommand,
    ]),
  };
}

/**
 * What rust-analyzer loads from the start: the worktree's manifest, or else those one level down. A
 * trusted server runs what it loads on the worktree's trust, so an untrusted repository in a folder
 * there stays out.
 */
export function findRustManifests(wtPath: string, repoTrusted: boolean): string[] {
  const own = path.join(wtPath, RUST_MANIFEST);
  if (isReadableRustManifest(own, wtPath)) return [own];
  try {
    return readdirSync(wtPath, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(wtPath, entry.name, RUST_MANIFEST))
      .filter((manifest) => isReadableRustManifest(manifest, wtPath))
      .filter((manifest) => !repoTrusted || untrustedNestedRepo(manifest, wtPath) === null)
      .toSorted();
  } catch {
    return [];
  }
}

/** Whether a changed file can change {@link findRustManifests}'s answer. */
export function isRustManifestPath(wtPath: string, changed: string): boolean {
  const parts = path.relative(wtPath, changed).split(path.sep);
  return parts.length <= 2 && parts.at(-1) === RUST_MANIFEST;
}

/**
 * Why rust-analyzer could not load this manifest, or null when it can. A server that fails on one
 * linked project stops taking in new ones, and its status does not say which one failed, so a
 * project is checked before it is added, with the command the server itself runs for a project, in
 * the server's environment, from the manifest's folder as the server does.
 */
export async function rustManifestProblem(
  { cargo, env }: Pick<RunPlan, "cargo" | "env">,
  manifest: string,
): Promise<string | null> {
  try {
    const proc = Bun.spawn(
      [
        cargo,
        "metadata",
        "--no-deps",
        "--offline",
        "--format-version",
        "1",
        "--color",
        "never",
        "--manifest-path",
        manifest,
      ],
      {
        cwd: path.dirname(manifest),
        env: { ...buildSpawnEnv(), ...env },
        stdin: "ignore",
        stdout: "ignore",
        stderr: "pipe",
        timeout: MANIFEST_CHECK_TIMEOUT_MS,
      },
    );
    const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    if (exitCode === 0) return null;
    if (proc.signalCode !== null) return "cargo did not finish in time.";
    return (
      stderr.split("\n").find((line) => line.startsWith("error:")) ?? "cargo could not read it."
    );
  } catch {
    return "cargo could not be started.";
  }
}

/**
 * rust-analyzer's settings. They go in `initializationOptions`, since it pulls configuration only
 * after `didChangeConfiguration`. The projects are always listed, so it never looks for any itself:
 * a project file can name a toolchain, and opening a file would start a search from that file.
 */
export function rustAnalyzerSettings(
  {
    sysroot,
    host,
    rustSrc,
    repoTrusted,
    checkCommand,
  }: Pick<RunPlan, "sysroot" | "host" | "rustSrc" | "repoTrusted" | "checkCommand">,
  manifests: readonly string[],
  looseFiles: readonly string[] = [],
): Record<string, unknown> {
  const linkedProjects: unknown[] = [...manifests];
  if (looseFiles.length > 0) {
    // One project for all of them, listed here rather than through a `rust-project.json`.
    linkedProjects.push({
      sysroot: rustSrc ? sysroot : null,
      ...(rustSrc && { sysroot_src: path.join(sysroot, SYSROOT_LIBRARY) }),
      crates: looseFiles.map((file) => ({
        root_module: file,
        edition: LOOSE_FILE_EDITION,
        deps: [],
      })),
    });
  }
  return {
    checkOnSave: repoTrusted,
    ...(repoTrusted && { check: { command: checkCommand } }),
    cargo: {
      buildScripts: { enable: repoTrusted },
      // Left to search for one, it installs the sources when they are missing; a named one without
      // sources fails the whole project, where none still serves the project's own crates.
      sysroot: rustSrc ? sysroot : null,
      // Trusted: its own build directory, so a build in a terminal does not wait on its lock.
      // Untrusted: beats the `build.target` of cargo's config, which can name a repository's file.
      ...(repoTrusted ? { targetDir: true } : { target: host }),
    },
    procMacro: {
      enable: repoTrusted,
      // Found through the sysroot otherwise, and none is named without the standard library's sources.
      ...(repoTrusted && !rustSrc && { server: path.join(sysroot, SYSROOT_PROC_MACRO_SERVER) }),
    },
    linkedProjects: linkedProjects.length > 0 ? linkedProjects : [NO_PROJECT],
  };
}

/** rust-analyzer's project status: only this reports dependencies that could not be read. */
const SERVER_STATUS = "experimental/serverStatus";
const MISSING_DEPENDENCIES = "Failed to read Cargo metadata with dependencies";

/**
 * The client's `initialize` frame, asking for the project status and to resolve completions'
 * documentation. rust-analyzer offers resolving, and so auto-imports, only when some property other
 * than `additionalTextEdits` is resolvable. Other frames as they are.
 *
 * A trusted server also loses pull diagnostics, since it has two kinds to show. It serves its own by
 * pull and sends `cargo check`'s by push, and both land on one marker owner in the client, so one
 * replaces the other. Without the capability it pushes the two merged.
 */
export function withRustClientCapabilities(data: string, repoTrusted: boolean): string {
  if (!data.includes('"initialize"')) return data;
  try {
    const frame: unknown = JSON.parse(data);
    if (!isRecord(frame) || frame.method !== "initialize" || !isRecord(frame.params)) return data;
    // Nothing may override the settings, which the manager adds next.
    delete frame.params.initializationOptions;
    const { capabilities } = frame.params;
    if (!isRecord(capabilities)) return JSON.stringify(frame);
    const experimental = isRecord(capabilities.experimental) ? capabilities.experimental : {};
    capabilities.experimental = { ...experimental, serverStatusNotification: true };
    const { textDocument } = capabilities;
    if (repoTrusted && isRecord(textDocument)) delete textDocument.diagnostic;
    const completion = isRecord(textDocument) ? textDocument.completion : undefined;
    const item = isRecord(completion) ? completion.completionItem : undefined;
    if (isRecord(item) && isRecord(item.resolveSupport)) {
      const { properties } = item.resolveSupport;
      if (Array.isArray(properties)) {
        item.resolveSupport.properties = [...new Set([...properties, "documentation"])];
      }
    }
    return JSON.stringify(frame);
  } catch {
    return data;
  }
}

/**
 * A server frame without the pull diagnostics rust-analyzer offers whatever the client said, so the
 * client does not ask for them on top of the merged push. Other frames as they are.
 */
export function withoutPullDiagnostics(body: string): string {
  if (!body.includes('"diagnosticProvider"')) return body;
  try {
    const frame: unknown = JSON.parse(body);
    if (!isRecord(frame) || !isRecord(frame.result) || !isRecord(frame.result.capabilities)) {
      return body;
    }
    delete frame.result.capabilities.diagnosticProvider;
    return JSON.stringify(frame);
  } catch {
    return body;
  }
}

/** Client methods that can start something in the server, none of which Loxel's client uses. */
const BLOCKED_METHODS: ReadonlySet<string> = new Set([
  "textDocument/didSave",
  "textDocument/formatting",
  "textDocument/rangeFormatting",
  "workspace/didChangeConfiguration",
  "workspace/executeCommand",
]);
const BLOCKED_METHOD_PREFIXES = ["rust-analyzer/", "experimental/"];

/**
 * Whether a client frame must not reach the server. A save can re-read `checkOnSave` from the
 * repository's `rust-analyzer.toml`, and a changed configuration replaces the restricted settings.
 */
export function blockedClientMethod(data: string): { id?: unknown; method: string } | null {
  try {
    const frame: unknown = JSON.parse(data);
    if (!isRecord(frame) || typeof frame.method !== "string") return null;
    const { method, id } = frame;
    const blocked =
      BLOCKED_METHODS.has(method) ||
      BLOCKED_METHOD_PREFIXES.some((prefix) => method.startsWith(prefix));
    return blocked ? { id, method } : null;
  } catch {
    return null;
  }
}

/** A client frame about a document's life, with the document's path. */
export function readDocumentLifecycle(data: string): { opened: boolean; file: string } | null {
  if (!data.includes('"textDocument/didOpen"') && !data.includes('"textDocument/didClose"')) {
    return null;
  }
  try {
    const frame: unknown = JSON.parse(data);
    if (!isRecord(frame) || !isRecord(frame.params) || !isRecord(frame.params.textDocument)) {
      return null;
    }
    const { uri } = frame.params.textDocument;
    if (typeof uri !== "string" || !uri.startsWith("file:") || !uri.endsWith(".rs")) return null;
    if (frame.method === "textDocument/didOpen") return { opened: true, file: fileURLToPath(uri) };
    if (frame.method === "textDocument/didClose") {
      return { opened: false, file: fileURLToPath(uri) };
    }
    return null;
  } catch {
    return null;
  }
}

/** Every process below `pid` that a `ps` lists now, from the system's `ps` whatever `PATH` holds. */
function descendantsOf(pid: number): number[] {
  const { stdout, success } = Bun.spawnSync(["ps", "-A", "-o", "pid=,ppid="], {
    env: { PATH: "/bin:/usr/bin" },
    stdin: "ignore",
    stderr: "ignore",
  });
  if (!success) return [];
  const children = new Map<number, number[]>();
  for (const line of stdout.toString().split("\n")) {
    const [child, parent] = line.trim().split(/\s+/).map(Number);
    if (child === undefined || parent === undefined) continue;
    children.set(parent, [...(children.get(parent) ?? []), child]);
  }
  const found: number[] = [];
  const queue = [pid];
  for (let next = queue.pop(); next !== undefined; next = queue.pop()) {
    for (const child of children.get(next) ?? []) {
      found.push(child);
      queue.push(child);
    }
  }
  return found;
}

/** How many times to look for processes started while the ones found so far were being stopped. */
const MAX_STOP_ROUNDS = 5;

function signalIfAlive(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch {
    // Finished on its own.
  }
}

/**
 * End everything a server has started: `cargo`, what cargo runs, and its proc macro server. Stopping
 * rust-analyzer leaves them behind, since it starts some in process groups of its own and some in its
 * own group, with no handler to end either. A process is frozen before any is killed, as a killed
 * parent's children would no longer be found below the server, and a frozen one starts nothing new.
 */
export function endServerChildren(pid: number): void {
  const frozen = new Set<number>();
  try {
    for (let round = 0; round < MAX_STOP_ROUNDS; round++) {
      const fresh = descendantsOf(pid).filter((child) => !frozen.has(child));
      if (fresh.length === 0) break;
      for (const child of fresh) {
        signalIfAlive(child, "SIGSTOP");
        frozen.add(child);
      }
    }
  } catch (err) {
    // No `ps` to run. What was found still goes, and closing the session must carry on regardless.
    log.warn("Could not list what rust-analyzer started", { error: err });
  }
  for (const child of frozen) signalIfAlive(child, "SIGKILL");
}

export interface RustServerStatus {
  /** What to tell the user, by kind so each is told once. */
  notices: { kind: string; message: string }[];
}

/** The project a status names as missing dependencies, by its manifest in backquotes. */
const MISSING_DEPENDENCIES_OF = new RegExp(`${MISSING_DEPENDENCIES} for \`([^\`]+)\``, "g");

/** The notice for a project whose dependencies could not be read; no directory for the root's. */
function missingDependenciesNotice(wtPath: string, manifest?: string) {
  const directory = manifest ? path.relative(wtPath, path.dirname(manifest)) : "";
  if (directory === "" || directory.startsWith("..") || path.isAbsolute(directory)) {
    return {
      kind: "dependencies",
      message:
        "Some dependencies are not available locally, so their items are unknown. Loxel does not download them: run `cargo fetch` in a terminal, then Restart Language Servers.",
    };
  }
  return {
    kind: `dependencies:${directory}`,
    message: `Some dependencies of ${directory} are not available locally, so their items are unknown. Loxel does not download them: run \`cargo fetch\` in that folder in a terminal, then Restart Language Servers.`,
  };
}

/**
 * Read a server frame as the project status, or null for any other frame. rust-analyzer's own words
 * name internal commands and suggest running without `--offline`; this says what the user can do.
 */
export function readServerStatus(body: string, wtPath: string): RustServerStatus | null {
  if (!body.includes(SERVER_STATUS)) return null;
  try {
    const frame: unknown = JSON.parse(body);
    if (!isRecord(frame) || frame.method !== SERVER_STATUS || !isRecord(frame.params)) return null;
    const { health, message } = frame.params;
    const text = typeof message === "string" ? message : "";
    if (text.includes(MISSING_DEPENDENCIES)) {
      const manifests = [...text.matchAll(MISSING_DEPENDENCIES_OF)].map((match) => match[1]);
      return {
        notices:
          manifests.length > 0
            ? manifests.map((manifest) => missingDependenciesNotice(wtPath, manifest))
            : [missingDependenciesNotice(wtPath)],
      };
    }
    if (health !== "error") return { notices: [] };
    const firstError = text.split("\n").find((line) => line.startsWith("error:"));
    return {
      notices: [
        {
          kind: "project",
          message: `Could not load this Rust project. ${firstError ?? "Check that Cargo.toml is valid."}`,
        },
      ],
    };
  } catch {
    return null;
  }
}
