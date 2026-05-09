/**
 * Client-side registry that merges glob-based (configured) schemas with
 * per-file `$schema`-detected schemas and applies them to Monaco's JSON
 * language service via `setDiagnosticsOptions`.
 *
 * Monaco's `setDiagnosticsOptions` is global — it replaces all schemas at
 * once — so we maintain a single merged list and rebuild on every mutation.
 */
import * as monaco from "monaco-editor";

interface ResolvedSchema {
  glob: string;
  url: string;
  schema: unknown;
}

/** Glob-based schemas from settings (resolved inline by server). */
let configuredSchemas: ResolvedSchema[] = [];

/** Per-file schemas detected from $schema fields. Key: file URI string. */
const dollarSchemaMap = new Map<string, { url: string; schema: unknown }>();

/** Update configured schemas (from settings sync). Rebuilds Monaco config. */
export function setConfiguredSchemas(schemas: ResolvedSchema[]): void {
  configuredSchemas = schemas;
  applyToMonaco();
}

/** Register a $schema-detected schema for a specific file URI. Rebuilds Monaco config. */
export function setDollarSchema(fileUri: string, url: string, schema: unknown): void {
  dollarSchemaMap.set(fileUri, { url, schema });
  applyToMonaco();
}

/** Remove a $schema registration (file closed or $schema removed). */
export function removeDollarSchema(fileUri: string): void {
  if (dollarSchemaMap.delete(fileUri)) {
    applyToMonaco();
  }
}

// ---------------------------------------------------------------------------

function applyToMonaco(): void {
  const schemas: Array<{ uri: string; fileMatch?: string[]; schema?: unknown }> = [];

  // Glob-based schemas from settings
  for (const s of configuredSchemas) {
    schemas.push({ uri: s.url, fileMatch: [s.glob], schema: s.schema });
  }

  // Per-file $schema overrides — use exact file URI as fileMatch
  for (const [fileUri, { url, schema }] of dollarSchemaMap) {
    schemas.push({ uri: url, fileMatch: [fileUri], schema });
  }

  monaco.json.jsonDefaults.setDiagnosticsOptions({
    validate: true,
    allowComments: true,
    comments: "ignore",
    trailingCommas: "ignore",
    enableSchemaRequest: false,
    schemas,
  });
}
