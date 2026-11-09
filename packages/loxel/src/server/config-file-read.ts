import { readFileSync, statSync } from "node:fs";

/** A config file is far smaller than this; a read blocks the server, so larger ones are skipped. */
const MAX_CONFIG_FILE_BYTES = 1024 * 1024;

/**
 * The text of the config file at `path`, or undefined when it is missing, unreadable, or not a
 * regular file of at most {@link MAX_CONFIG_FILE_BYTES} (reading a FIFO would never return).
 */
export function readConfigFile(path: string): string | undefined {
  try {
    const stat = statSync(path);
    if (!stat.isFile() || stat.size > MAX_CONFIG_FILE_BYTES) return undefined;
    return readFileSync(path, "utf-8");
  } catch {
    return undefined;
  }
}
