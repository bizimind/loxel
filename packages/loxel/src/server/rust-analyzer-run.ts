import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import type { RustToolchain } from "@/api/rust-toolchain-model";
import { isRecord } from "@/lib/is-record";

import { pathOutsideWorktree } from "./python-env";
import { rustToolEnv } from "./rust-toolchain";
import { buildSpawnEnv } from "./shell-env";

const COMMAND_TIMEOUT_MS = 10_000;
const MANIFEST = "Cargo.toml";

/**
 * The oldest rust-analyzer Loxel starts, by the date in its version. Older ones are not known to
 * honor the settings the restricted mode rests on.
 */
export const MIN_RUST_ANALYZER_DATE = "2025-01-07";

/** The inline project for a worktree without a manifest: nothing is looked for on disk instead. */
const NO_PROJECT = { sysroot: null, crates: [] };

/** How to start rust-analyzer for a worktree, or why it does not start. */
export type RustAnalyzerPlan =
  | {
      kind: "run";
      binary: string;
      env: Record<string, string>;
      sysroot: string;
      /** The compiler's own target, the one analyzed. */
      host: string;
      /** The toolchain has the standard library's sources. */
      rustSrc: boolean;
      /** Whether two plans run the same thing; a different one calls for a restart. */
      key: string;
    }
  | { kind: "refuse"; reason: string };

function refuse(reason: string): RustAnalyzerPlan {
  return { kind: "refuse", reason };
}

/** What to do about a toolchain nothing can run from. Each reason fits a WebSocket close frame. */
function unusableReason(toolchain: Exclude<RustToolchain, { status: "active" }>): string {
  switch (toolchain.status) {
    case "not-installed":
      return `Rust toolchain ${toolchain.name} is not installed. Run: rustup toolchain install ${toolchain.name}`;
    case "refused":
      return "The repository selects its own Rust toolchain. Pick an installed one: Rust: Select Toolchain";
    case "none":
      return toolchain.rustupPath
        ? "rustup has no usable toolchain. Run: rustup default stable"
        : "Rust was not found. Install it from https://rustup.rs";
  }
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

/** The variables that keep a session on the resolved toolchain and away from the repository's. */
export function rustAnalyzerEnv(
  toolchain: Extract<RustToolchain, { status: "active" }>,
  cargo: string,
  inheritedPath: string,
  wtPath: string,
): Record<string, string> {
  return {
    ...rustToolEnv(toolchain),
    // Beats a toolchain file for every proxy the server starts.
    ...(toolchain.name && { RUSTUP_TOOLCHAIN: toolchain.name }),
    PATH: pathOutsideWorktree(inheritedPath, wtPath),
    CARGO: cargo,
    RUSTC: toolchain.rustcPath,
    RUSTC_WRAPPER: "",
    RUSTC_WORKSPACE_WRAPPER: "",
    CARGO_ENCODED_RUSTFLAGS: "",
    CARGO_ENCODED_RUSTDOCFLAGS: "",
    CARGO_TARGET_APPLIES_TO_HOST: "true",
    CARGO_UNSTABLE_HOST_CONFIG: "false",
    CARGO_NET_OFFLINE: "true",
    CARGO_NET_GIT_FETCH_WITH_CLI: "false",
  };
}

/**
 * Decide how to start rust-analyzer for a worktree's toolchain. Everything run here runs from the
 * home directory with the toolchain pinned, so it answers for the binary the session will run and
 * no file in the worktree selects anything.
 */
export async function planRustAnalyzer(
  wtPath: string,
  toolchain: RustToolchain,
): Promise<RustAnalyzerPlan> {
  if (toolchain.status !== "active") return refuse(unusableReason(toolchain));
  // A toolchain file's `path`: outside the worktree, but still the repository's pick of a binary.
  if (toolchain.source === "toolchain-file" && path.isAbsolute(toolchain.name ?? "")) {
    return refuse(
      "The repository selects a Rust toolchain by path. Pick an installed one: Rust: Select Toolchain",
    );
  }
  const { rustAnalyzer, cargo, rustSrc } = toolchain.tools;
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
  const home = spawnEnv.HOME ?? homedir();
  const pinned = {
    ...spawnEnv,
    ...rustToolEnv(toolchain),
    ...(toolchain.name && { RUSTUP_TOOLCHAIN: toolchain.name }),
  };
  const version = await capture([rustAnalyzer, "--version"], home, pinned);
  const date = version === null ? null : rustAnalyzerDate(version);
  if (date === null)
    return refuse("Could not read rust-analyzer's version, so it was not started.");
  if (date < MIN_RUST_ANALYZER_DATE) {
    return refuse(
      `This rust-analyzer (${date}) is too old for Loxel. Update it, or pick a newer toolchain.`,
    );
  }
  const compiler = await capture([toolchain.rustcPath, "-vV"], home, pinned);
  const host = compiler === null ? null : /^host: (\S+)$/m.exec(compiler)?.[1];
  if (!host) return refuse("Could not read the Rust compiler's host target.");

  return {
    kind: "run",
    binary: rustAnalyzer,
    env: rustAnalyzerEnv(toolchain, cargo, spawnEnv.PATH ?? "", wtPath),
    sysroot: toolchain.sysroot,
    host,
    rustSrc,
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
    ]),
  };
}

function isFile(file: string): boolean {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

/** The manifests rust-analyzer loads: the worktree's own, or else those one directory down. */
export function findRustManifests(wtPath: string): string[] {
  const own = path.join(wtPath, MANIFEST);
  if (isFile(own)) return [own];
  try {
    return readdirSync(wtPath, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(wtPath, entry.name, MANIFEST))
      .filter(isFile)
      .toSorted();
  } catch {
    return [];
  }
}

/** Whether a changed file can change {@link findRustManifests}'s answer. */
export function isRustManifestPath(wtPath: string, changed: string): boolean {
  const parts = path.relative(wtPath, changed).split(path.sep);
  return parts.length <= 2 && parts.at(-1) === MANIFEST;
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
  }: Pick<Extract<RustAnalyzerPlan, { kind: "run" }>, "sysroot" | "host" | "rustSrc">,
  manifests: readonly string[],
): Record<string, unknown> {
  return {
    checkOnSave: false,
    cargo: {
      buildScripts: { enable: false },
      // Left to search for one, it installs the sources when they are missing; a named one without
      // sources fails the whole project, where none still serves the project's own crates.
      sysroot: rustSrc ? sysroot : null,
      // Beats the `build.target` of cargo's config, which can name a file of the repository.
      target: host,
    },
    procMacro: { enable: false },
    linkedProjects: manifests.length > 0 ? manifests : [NO_PROJECT],
  };
}

/** rust-analyzer's project status: only this reports dependencies that could not be read. */
const SERVER_STATUS = "experimental/serverStatus";
const MISSING_DEPENDENCIES = /Failed to read Cargo metadata with dependencies/;

/**
 * The client's `initialize` frame, asking for the project status and to resolve completions'
 * documentation. rust-analyzer offers resolving, and so auto-imports, only when some property other
 * than `additionalTextEdits` is resolvable. Other frames as they are.
 */
export function withRustClientCapabilities(data: string): string {
  if (!data.includes('"initialize"')) return data;
  try {
    const frame: unknown = JSON.parse(data);
    if (!isRecord(frame) || frame.method !== "initialize" || !isRecord(frame.params)) return data;
    const { capabilities } = frame.params;
    if (!isRecord(capabilities)) return data;
    const experimental = isRecord(capabilities.experimental) ? capabilities.experimental : {};
    capabilities.experimental = { ...experimental, serverStatusNotification: true };
    const { textDocument } = capabilities;
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

export interface RustServerStatus {
  /** What to tell the user, by kind so each is told once; null when there is nothing to tell. */
  notice: { kind: "dependencies" | "project"; message: string } | null;
}

/**
 * Read a server frame as the project status, or null for any other frame. rust-analyzer's own words
 * name internal commands and suggest running without `--offline`; this says what the user can do.
 */
export function readServerStatus(body: string): RustServerStatus | null {
  if (!body.includes(SERVER_STATUS)) return null;
  try {
    const frame: unknown = JSON.parse(body);
    if (!isRecord(frame) || frame.method !== SERVER_STATUS || !isRecord(frame.params)) return null;
    const { health, message } = frame.params;
    const text = typeof message === "string" ? message : "";
    if (MISSING_DEPENDENCIES.test(text)) {
      return {
        notice: {
          kind: "dependencies",
          message:
            "Some dependencies are not available locally, so their items are unknown. Loxel does not download them: run `cargo fetch` in a terminal, then Restart Language Servers.",
        },
      };
    }
    if (health !== "error") return { notice: null };
    const firstError = text.split("\n").find((line) => line.startsWith("error:"));
    return {
      notice: {
        kind: "project",
        message: `Could not load this Rust project. ${firstError ?? "Check that Cargo.toml is valid."}`,
      },
    };
  } catch {
    return null;
  }
}
