import { realpathSync } from "node:fs";
import path from "node:path";

import {
  WorktreeLspManager,
  type SpawnOptions,
  type SuppressibleFeature,
  type WtLspContext,
  type WtLspSession,
} from "./stdio-lsp-manager";

const TOMBI = process.platform === "win32" ? "tombi.exe" : "tombi";

/**
 * Manages Tombi (`tombi lsp`) child processes, one per worktree. Loxel's schema settings reach
 * Tombi as editor configuration (`workspace/didChangeConfiguration`), which Tombi uses for every
 * TOML file not governed by a Tombi config file of its own (`tombi.toml`, `[tool.tombi]`, the
 * user's `~/.config/tombi/config.toml`), so those projects keep the behavior of the `tombi` CLI.
 */
export class TomlLspManager extends WorktreeLspManager {
  // TOML is highlighted by its TextMate grammar; Tombi's tokens would only recolor it.
  protected override readonly disableSemanticTokens = true;
  // Format on save owns formatting, and Tombi's formatter reorders keys by the schema.
  protected override readonly suppressedFeatures: readonly SuppressibleFeature[] = [
    "textDocument/formatting",
    "textDocument/rangeFormatting",
  ];
  // Tombi watches its config files and local schemas.
  protected override readonly forwardWatchedFiles = true;

  /** Sessions whose client has sent `initialized`, which may take configuration. */
  private readonly initializedSessions = new WeakSet<WtLspSession>();

  /** Hosts of schemas the user chose; Tombi refuses a non-public host unless it is listed. */
  private trustedHosts: readonly string[] = [];

  constructor(
    private schemaMap: Record<string, string[]>,
    private readonly cacheDir: string,
  ) {
    super("toml-lsp");
  }

  /** The hosts a session started from now on trusts. Offline, this only lets it read its cache. */
  setTrustedHosts(hosts: readonly string[]): void {
    this.trustedHosts = hosts;
  }

  /** Replace the schema mappings (schema URL → Loxel globs) and push them to every session. */
  updateSchemas(schemaMap: Record<string, string[]>): void {
    this.schemaMap = schemaMap;
    for (const session of this.sessions.values()) {
      if (this.initializedSessions.has(session)) this.pushSchemaConfig(session);
    }
    this.log.info("Updated TOML schemas", { schemaCount: Object.keys(schemaMap).length });
  }

  // ---------------------------------------------------------------------------

  protected resolveBinary(): string | null {
    return this.resolveBundledBinary(TOMBI, path.resolve(import.meta.dir, "../../build", TOMBI));
  }

  // Offline, Tombi reads schemas only from its cache, which `SchemaDownloads` fills.
  protected override spawnArgs(): readonly string[] {
    return ["lsp", "--offline"];
  }

  protected override spawnOptions(context: WtLspContext): SpawnOptions {
    return {
      ...super.spawnOptions(context),
      env: {
        TOMBI_CACHE_HOME: this.cacheDir,
        TOMBI_SCHEMA_TRUSTED_HOSTS: this.trustedHosts.join(","),
      },
    };
  }

  protected override onClientInitialized(session: WtLspSession): void {
    this.initializedSessions.add(session);
    this.pushSchemaConfig(session);
  }

  private pushSchemaConfig(session: WtLspSession): void {
    this.writeToStdin(
      session,
      JSON.stringify({
        jsonrpc: "2.0",
        method: "workspace/didChangeConfiguration",
        params: { settings: tombiSettings(this.schemaMap, canonicalPath(session.wtPath)) },
      }),
    );
    // Tombi keeps each open document's diagnostics until it changes, and a configuration change
    // does not clear them. An association matching no file does, and makes Tombi ask the client
    // to pull diagnostics again (`workspace/diagnostic/refresh`). Tombi keeps every association,
    // so each push leaves one more of these inert entries behind for the session's lifetime.
    this.writeToStdin(
      session,
      JSON.stringify({
        jsonrpc: "2.0",
        method: "tombi/associateSchema",
        params: { uri: REFRESH_SCHEMA_URI, fileMatch: [] },
      }),
    );
  }
}

/** Never fetched: an association without file patterns matches no file. */
const REFRESH_SCHEMA_URI = "tombi://loxel.invalid/refresh.json";

/** Tombi matches patterns against canonical paths (`/tmp` is `/private/tmp` on macOS). */
function canonicalPath(dir: string): string {
  try {
    return realpathSync(dir);
  } catch {
    return dir;
  }
}

/**
 * Tombi's editor configuration for Loxel's schema mappings in the worktree at `root`. The
 * catalogs' associations are off, so the mappings in Settings > Schemas are the only automatic
 * ones (disabling a built-in removes it), and `#:schema` directives in a file still win.
 * Strict mode is off, so a schema validates TOML by the JSON Schema rules it validates JSON and
 * YAML with (Tombi's strict mode treats a missing `additionalProperties` as `false`).
 */
export function tombiSettings(
  schemaMap: Record<string, string[]>,
  root: string,
): Record<string, unknown> {
  return {
    tombi: {
      schema: { strict: false, catalog: { paths: [] } },
      schemas: Object.entries(schemaMap).map(([url, globs]) => ({
        path: url,
        include: globs.flatMap((glob) => toTombiPatterns(glob, root)),
      })),
    },
  };
}

/**
 * Tombi's patterns for one Loxel schema glob, for the worktree at `root`. Loxel globs match like
 * Monaco's JSON `fileMatch`: at any depth (`pyproject.toml` and `config/*.toml` match in every
 * directory) and with brace alternatives. Tombi knows no braces, so the alternatives are
 * expanded. It matches patterns against the absolute path, where `*` also matches `/`, so a
 * pattern with wildcards is anchored at the worktree (`config/*.toml` must not match every TOML
 * file below an ancestor directory named `config`), while a plain name such as `pyproject.toml`
 * matches anywhere, files outside the worktree included.
 */
export function toTombiPatterns(glob: string, root: string): string[] {
  const relative = glob.replace(/^\/+/, "");
  if (!relative) return [];
  return expandBraces(relative).map((pattern) => {
    const rest = pattern.replace(/^(\*\*\/)+/, "");
    return /[*?]/.test(rest) ? `${escapeGlob(root)}/**/${rest}` : `**/${rest}`;
  });
}

/** Escape a literal path for Tombi's glob syntax (Rust's `glob` crate). */
function escapeGlob(literal: string): string {
  return literal.replace(/[*?[\]]/g, (char) => `[${char}]`);
}

/** Expand `{a,b}` alternatives, innermost first: `*.{yml,yaml}` → `*.yml`, `*.yaml`. */
function expandBraces(pattern: string): string[] {
  const match = /\{([^{}]*)\}/.exec(pattern);
  if (!match) return [pattern];
  const before = pattern.slice(0, match.index);
  const after = pattern.slice(match.index + match[0].length);
  return match[1]!.split(",").flatMap((alternative) => expandBraces(before + alternative + after));
}
