import * as z from "zod";

import { WtConfigSchema } from "./schema.ts";

/**
 * Generate JSON Schema for wt.yaml configuration.
 * This can be used for IDE autocomplete in YAML files.
 *
 * Usage in wt.yaml:
 * ```yaml
 * # yaml-language-server: $schema=https://loxel.bizimind.io/wt/schema.json
 * ```
 *
 * Or generate locally:
 * ```bash
 * bun run packages/wt/src/config/json-schema.ts > wt.schema.json
 * ```
 */
export function generateJsonSchema(): object {
  // Use draft-07 for wide IDE support
  return z.toJSONSchema(WtConfigSchema, { target: "draft-07", unrepresentable: "any" });
}

/** Pre-computed JSON Schema for wt.yaml — importable as a constant by consumers like loxel. */
export const WT_CONFIG_JSON_SCHEMA: object = generateJsonSchema();

// When run directly, output the schema
if (import.meta.main) {
  process.stdout.write(JSON.stringify(WT_CONFIG_JSON_SCHEMA, null, 2) + "\n");
}
