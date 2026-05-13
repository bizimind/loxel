import { existsSync } from "node:fs";
import path from "node:path";

import { resolveTsgoBinary } from "./tsgo-path";

export interface TsLspBackend {
  name: "tsgo" | "tsls";
  /** Return the absolute path to the backend binary, or null if unavailable. */
  resolveBinary(): string | null;
  /** Args passed after the binary. */
  spawnArgs: readonly string[];
}

const tsgo: TsLspBackend = {
  name: "tsgo",
  resolveBinary: resolveTsgoBinary,
  spawnArgs: ["--lsp", "-stdio"],
};

const tsls: TsLspBackend = {
  name: "tsls",
  resolveBinary: () => {
    const sibling = path.join(path.dirname(process.execPath), "typescript-language-server");
    if (existsSync(sibling)) return sibling;

    try {
      const pkgJson = Bun.resolveSync(
        "typescript-language-server/package.json",
        path.dirname(process.execPath),
      );
      // Walk up to the node_modules root that owns this package and use its `.bin` shim.
      const nodeModulesDir = path.resolve(path.dirname(pkgJson), "..");
      const candidate = path.join(nodeModulesDir, ".bin/typescript-language-server");
      if (existsSync(candidate)) return candidate;
    } catch {
      // Not installed — fall through.
    }

    return Bun.which("typescript-language-server");
  },
  spawnArgs: ["--stdio"],
};

export function selectTsLspBackend(): TsLspBackend {
  const choice = (process.env.LOXEL_TS_LSP ?? "tsls").toLowerCase();
  return choice === "tsgo" ? tsgo : tsls;
}
