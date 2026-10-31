import { readFileSync, statSync } from "node:fs";

import { isRecord } from "@/lib/is-record";

/** A config file is far smaller than this; a read blocks the server, so larger ones are skipped. */
const MAX_TOML_BYTES = 1024 * 1024;

/**
 * The top-level table of the TOML file at `path`, or undefined when it is missing, unparsable, or
 * not a regular file of at most {@link MAX_TOML_BYTES} (reading a FIFO would never return).
 */
export function readToml(path: string): Record<string, unknown> | undefined {
  try {
    const stat = statSync(path);
    if (!stat.isFile() || stat.size > MAX_TOML_BYTES) return undefined;
    return parseToml(readFileSync(path, "utf-8"));
  } catch {
    return undefined;
  }
}

/** The top-level table of TOML `text`, or undefined when it is unparsable. */
export function parseToml(text: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = Bun.TOML.parse(text);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    // An unparsable file contributes nothing; the tool that reads it reports the error if it runs.
    return undefined;
  }
}

/** The table at `key` of `value`, when both are tables. */
export function recordAt(value: unknown, key: string): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const child = value[key];
  return isRecord(child) ? child : undefined;
}
