import { dirname, join, relative, resolve } from "node:path";

import type { RustToolchain } from "@/api/rust-toolchain-model";

import { readConfigFile } from "./config-file-read";
import {
  dirsUpToRoot,
  type FileFormatter,
  type FormatterDecline,
  type FormatterFailure,
  type FormatterSpawnOptions,
  type LanguageFormatter,
} from "./language-formatter";
import { logger } from "./logger";
import { getRustToolchainNow, RUST_LOXEL_TOOL_ENV, rustToolEnv } from "./rust-toolchain";
import { parseToml, readToml, recordAt } from "./toml-file";

const log = logger.child("format");

const RUSTFMT = "rustfmt";
const MANIFEST = "Cargo.toml";
/** In the order rustfmt prefers them within a directory (checked against 1.10.0). */
const CONFIG_FILES = [".rustfmt.toml", "rustfmt.toml"];
/** What Cargo assumes for a package that names no edition. */
const DEFAULT_EDITION = "2015";
/** Only what fits an edition reaches the command line; rustfmt rejects a year it doesn't know. */
const EDITION = /^\d{4}$/;
/** A first save resolves the toolchain; past this it goes out unformatted, and the next one has it. */
const TOOLCHAIN_LOOKUP_TIMEOUT_MS = 3_000;

const MISSING_COMPONENT = /^error: '[^']*' is not installed for the toolchain(?: '([\w.-]+)')?/m;
const NO_RUSTFMT =
  "Format on save skipped: this Rust has no rustfmt. Install it the way you installed Rust.";
const MISSING_TOOLCHAIN = /^error: toolchain '[^']*' is not installed/m;

/** Exported for tests, which choose the toolchain and need a lookup that cannot time out. */
export function rustFormatterWith(
  lookupTimeoutMs: number,
  getToolchain: (wtRoot: string) => Promise<RustToolchain> = getRustToolchainNow,
): LanguageFormatter {
  return {
    extensions: ["rs"],
    detect: detectRustFormatter,
    spawnOptions: (command, _dir, wtRoot) =>
      rustSpawnOptions(command, wtRoot, lookupTimeoutMs, getToolchain),
    failureNotice: rustFailureNotice,
  };
}

export const rustFormatter = rustFormatterWith(TOOLCHAIN_LOOKUP_TIMEOUT_MS);

/**
 * Format like `cargo fmt` for a file in `startDir`, walking up to `wtRoot`. Cargo's edition flag
 * always goes along inside a package, also when the rustfmt config sets its own `edition`: `cargo
 * fmt` passes it too and it wins, so leaving it out would format differently from a terminal. A
 * manifest Cargo could not read either means the edition is unknown, and a wrong one would rewrite
 * the file in that edition's style, so that file is not formatted.
 *
 * Not cached: a save costs a few `statSync` calls per directory level plus parsing a manifest or
 * two, negligible next to spawning the formatter.
 */
function detectRustFormatter(
  startDir: string,
  wtRoot: string,
): FileFormatter | FormatterDecline | null {
  const root = resolve(wtRoot);
  const dirs = dirsUpToRoot(startDir, root);
  const configPath = dirs
    .flatMap((dir) => CONFIG_FILES.map((name) => join(dir, name)))
    .find((path) => readConfigFile(path) !== undefined);
  const manifestIndex = dirs.findIndex((dir) => readConfigFile(join(dir, MANIFEST)) !== undefined);
  if (manifestIndex === -1 && !configPath) return null;

  const args: string[] = [];
  if (manifestIndex !== -1) {
    const edition = crateEdition(dirs.slice(manifestIndex));
    if (edition === undefined) {
      log.debug("Could not tell the crate's edition; not formatting", { startDir });
      return null;
    }
    if (edition) args.push(`--edition ${edition}`);
  }
  if (configPath) {
    // Relative to format-service's default cwd, the worktree: args are split on whitespace.
    const configArg = relative(root, configPath);
    if (/\s/.test(configArg)) {
      return {
        notice: `Format on save skipped: Loxel can't pass the rustfmt config "${configArg}" because its path has a space in it.`,
      };
    }
    args.push(`--config-path ${configArg}`);
  }
  return { command: RUSTFMT, args: args.join(" ") };
}

/**
 * The edition of the crate whose manifest is in `dirs[0]`, with its ancestors after it. Null when
 * the manifest has no package, as a virtual workspace's has not, so it says nothing about the file;
 * undefined when Cargo could not read it either.
 */
function crateEdition(dirs: readonly string[]): string | null | undefined {
  const text = readConfigFile(join(dirs[0] ?? "", MANIFEST));
  const manifest = text === undefined ? undefined : parseToml(text);
  if (!manifest) return undefined;
  const pkg = recordAt(manifest, "package");
  if (!pkg) return null;
  if (pkg.edition === undefined) return DEFAULT_EDITION;
  if (recordAt(pkg, "edition")?.workspace === true) {
    // `package.workspace` names the root; Cargo otherwise takes the nearest one.
    const named = typeof pkg.workspace === "string" ? resolve(dirs[0] ?? "", pkg.workspace) : null;
    return workspaceEdition(named ? [named] : dirs);
  }
  return validEdition(pkg.edition);
}

/** `[workspace.package] edition` of the nearest manifest with a `[workspace]`, as Cargo finds it. */
function workspaceEdition(dirs: readonly string[]): string | undefined {
  for (const dir of dirs) {
    const workspace = recordAt(readToml(join(dir, MANIFEST)), "workspace");
    if (workspace) return validEdition(recordAt(workspace, "package")?.edition);
  }
  return undefined;
}

function validEdition(edition: unknown): string | undefined {
  return typeof edition === "string" && EDITION.test(edition) ? edition : undefined;
}

/**
 * `rustfmt` by name is the worktree's: found first on `PATH`, and pinned to the toolchain that was
 * resolved, so it is the one the status bar shows. Any other command is the user's own override.
 */
async function rustSpawnOptions(
  command: string,
  wtRoot: string,
  lookupTimeoutMs: number,
  getToolchain: (wtRoot: string) => Promise<RustToolchain>,
): Promise<FormatterSpawnOptions> {
  if (command !== RUSTFMT) return { env: { ...RUST_LOXEL_TOOL_ENV } };
  try {
    const toolchain = await withinTimeout(getToolchain(wtRoot), lookupTimeoutMs);
    if (!toolchain) {
      log.info("The Rust toolchain is still resolving; not formatting", { wtRoot });
      return { skip: {} };
    }
    if (toolchain.status !== "active") return { skip: { notice: unusableNotice(toolchain) } };
    const { name, tools } = toolchain;
    if (!tools.rustfmt) {
      const notice = toolchain.source === "no-rustup" ? NO_RUSTFMT : missingComponentNotice(name);
      return { skip: { notice } };
    }
    return {
      env: {
        ...rustToolEnv(toolchain),
        ...(name ? { RUSTUP_TOOLCHAIN: name } : {}),
        // Nothing else on PATH: a tool gone since the resolution gets a notice, not another rustfmt.
        PATH: dirname(tools.rustfmt),
      },
      binDirs: [],
    };
  } catch (err) {
    // format-service's defaults, which a failure here would fall back to, are not for this tool.
    log.warn("Could not prepare rustfmt; not formatting", { wtRoot, error: err });
    return { skip: {} };
  }
}

async function withinTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<null>((done) => {
        timer = setTimeout(() => done(null), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function unusableNotice(toolchain: Exclude<RustToolchain, { status: "active" }>): string {
  if (toolchain.status === "not-installed") {
    return `Format on save skipped: the Rust toolchain "${toolchain.name}" is not installed. To install it, run \`rustup toolchain install\` in the project's folder.`;
  }
  if (toolchain.status === "refused") {
    return 'Format on save skipped: Loxel uses toolchains from outside the worktree. Choose an installed one with "Rust: Select Toolchain".';
  }
  const reason =
    toolchain.detail ??
    (toolchain.rustupPath
      ? "no Rust toolchain is active. To install one, run `rustup default stable` in a terminal."
      : "Rust was not found. To install it, see https://rustup.rs.");
  return `Format on save skipped: ${reason}`;
}

function missingComponentNotice(toolchain: string | null): string {
  const command = toolchain
    ? `rustup component add rustfmt --toolchain ${toolchain}`
    : "rustup component add rustfmt";
  return `Format on save skipped: this Rust toolchain has no rustfmt. To add it, run \`${command}\` in a terminal.`;
}

/** rustup's proxy reports these when a toolchain or its component went away since the resolution. */
function rustFailureNotice(failure: FormatterFailure): string | undefined {
  if (failure.kind === "not-installed") {
    return failure.command === RUSTFMT
      ? "Format on save skipped: rustfmt was not found. To install Rust, see https://rustup.rs."
      : undefined;
  }
  const component = MISSING_COMPONENT.exec(failure.stderr);
  if (component) return missingComponentNotice(component[1] ?? null);
  if (MISSING_TOOLCHAIN.test(failure.stderr)) {
    return "Format on save skipped: this project's Rust toolchain is not installed. To install it, run `rustup toolchain install` in the project's folder.";
  }
  return undefined;
}
