import { isRecord } from "@/lib/is-record";

import { readConfigFile } from "./config-file-read";

/**
 * The top-level table of the TOML file at `path`, or undefined when `readConfigFile` gives nothing
 * for it or it is unparsable.
 */
export function readToml(path: string): Record<string, unknown> | undefined {
  const text = readConfigFile(path);
  return text === undefined ? undefined : parseToml(text);
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
