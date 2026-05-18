import { existsSync } from "node:fs";
import path from "node:path";

import { resolveTsgoBinary } from "./tsgo-path";

export interface TsLspBackend {
  name: "tsgo" | "tsls";
  /** Return the absolute path to the binary (or runtime) to execute, or null if unavailable. */
  resolveBinary(): string | null;
  /** Args passed after the binary. For tsls this includes the script path. */
  readonly spawnArgs: readonly string[];
}

const tsgo: TsLspBackend = {
  name: "tsgo",
  resolveBinary: resolveTsgoBinary,
  spawnArgs: ["--lsp", "-stdio"],
};

/**
 * Resolve the bundled typescript-language-server.mjs script.
 * Production: sibling to loxel-server.  Dev: from node_modules.
 */
function resolveTslsScript(): string | null {
  const sibling = path.join(path.dirname(process.execPath), "typescript-language-server.mjs");
  if (existsSync(sibling)) return sibling;

  try {
    const pkgJson = Bun.resolveSync("typescript-language-server/package.json", import.meta.dir);
    const candidate = path.join(path.dirname(pkgJson), "lib/cli.mjs");
    if (existsSync(candidate)) return candidate;
  } catch {
    // Not installed — fall through.
  }

  return null;
}

const tsls: TsLspBackend = {
  name: "tsls",
  resolveBinary: () => {
    if (!resolveTslsScript()) return null;
    // typescript-language-server uses ChildProcess.fork() to spawn tsserver.js,
    // which requires process.execPath to be a real JS runtime — not a compiled binary.
    // In production, use the Electron binary with ELECTRON_RUN_AS_NODE=1.
    return process.env.LOXEL_ELECTRON ?? Bun.which("node");
  },
  get spawnArgs() {
    const script = resolveTslsScript();
    return script ? [script, "--stdio"] : [];
  },
};

export function selectTsLspBackend(): TsLspBackend {
  const choice = (process.env.LOXEL_TS_LSP ?? "tsls").toLowerCase();
  return choice === "tsgo" ? tsgo : tsls;
}
