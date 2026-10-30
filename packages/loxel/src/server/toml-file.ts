import { existsSync, readFileSync } from "node:fs";

import { isRecord } from "@/lib/is-record";

/** The top-level table of the TOML file at `path`, or undefined when it is missing or unparsable. */
export function readToml(path: string): Record<string, unknown> | undefined {
  if (!existsSync(path)) return undefined;
  try {
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
