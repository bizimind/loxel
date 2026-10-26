import path from "node:path";

import type { ServerWebSocket, Subprocess } from "bun";

import {
  type SpawnOptions,
  StdioLspManager,
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
export class TomlLspManager extends StdioLspManager<WtLspSession, WtLspContext> {
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

  constructor(private schemaMap: Record<string, string[]>) {
    super("toml-lsp");
  }

  createSession(ws: ServerWebSocket<unknown>, wtPath: string): void {
    this.startSession(ws, { wtPath });
  }

  destroySession(ws: ServerWebSocket<unknown>): void {
    this.detach(ws);
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

  protected override spawnArgs(): readonly string[] {
    return ["lsp"];
  }

  protected override spawnOptions(context: WtLspContext): SpawnOptions {
    return { cwd: context.wtPath };
  }

  protected buildSession(
    ws: ServerWebSocket<unknown>,
    proc: Subprocess,
    context: WtLspContext,
  ): WtLspSession {
    return {
      ws,
      proc,
      wtPath: context.wtPath,
      stdoutBuf: Buffer.alloc(0),
      documentContents: new Map(),
    };
  }

  protected override getSessionKey(context: WtLspContext): string {
    return context.wtPath;
  }

  protected override getSessionWorkspace(session: WtLspSession): string | null {
    return session.wtPath;
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
        params: { settings: tombiSettings(this.schemaMap) },
      }),
    );
    // Tombi keeps each open document's diagnostics until it changes, and a configuration change
    // does not clear them. An association matching no file does, and makes Tombi ask the client
    // to pull diagnostics again (`workspace/diagnostic/refresh`).
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

/**
 * Tombi's editor configuration for Loxel's schema mappings. The schema catalogs are off, so the
 * mappings in Settings > Schemas are the only automatic associations (disabling a built-in removes
 * it) and Tombi makes no catalog requests; `#:schema` directives in a file still win. Strict mode
 * is off, so a schema validates TOML by the JSON Schema rules it validates JSON and YAML with
 * (Tombi's strict mode treats a missing `additionalProperties` as `false`).
 */
export function tombiSettings(schemaMap: Record<string, string[]>): Record<string, unknown> {
  return {
    tombi: {
      schema: { strict: false, catalog: { paths: [] } },
      schemas: Object.entries(schemaMap).map(([url, globs]) => ({
        path: url,
        include: globs.flatMap(toTombiPatterns),
      })),
    },
  };
}

/**
 * Tombi's patterns for one Loxel schema glob. Loxel globs match like Monaco's JSON `fileMatch`:
 * at any depth (`pyproject.toml` and `config/*.toml` match in every directory) and with brace
 * alternatives. Tombi matches patterns containing `*` against the whole absolute path and knows
 * no braces, so the alternatives are expanded and the pattern anchored with `**\/`.
 */
export function toTombiPatterns(glob: string): string[] {
  const relative = glob.replace(/^\/+/, "");
  if (!relative) return [];
  return expandBraces(relative).map((pattern) =>
    pattern.startsWith("**/") ? pattern : `**/${pattern}`,
  );
}

/** Expand `{a,b}` alternatives, innermost first: `*.{yml,yaml}` → `*.yml`, `*.yaml`. */
function expandBraces(pattern: string): string[] {
  const match = /\{([^{}]*)\}/.exec(pattern);
  if (!match) return [pattern];
  const before = pattern.slice(0, match.index);
  const after = pattern.slice(match.index + match[0].length);
  return match[1]!.split(",").flatMap((alternative) => expandBraces(before + alternative + after));
}
