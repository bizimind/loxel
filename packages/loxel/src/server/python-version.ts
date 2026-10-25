import { stat } from "node:fs/promises";
import path from "node:path";

import { logger } from "./logger";
import { buildSpawnEnv } from "./shell-env";

const log = logger.child("server");

const VERSION_TIMEOUT_MS = 5000;
const VERSION_RE = /Python (\d+\.\d+\S*)/;

/** Versions by interpreter path and the identity of the file it resolves to. */
const cache = new Map<string, Promise<string | null>>();

/**
 * The version of a Python interpreter (`3.12.13`), from `<python> --version`, or null when it
 * cannot be read. Cached until the interpreter file changes (an upgrade or a recreated venv);
 * failures are not cached.
 * Only pass interpreters the resolver accepted: this executes the file. CPython prints the
 * version before reading any configuration or importing `site`, so no project code runs.
 */
export async function pythonVersion(pythonPath: string): Promise<string | null> {
  let key: string;
  try {
    const info = await stat(pythonPath);
    key = `${pythonPath}\0${info.dev}:${info.ino}:${info.mtimeMs}:${info.size}`;
  } catch {
    return null;
  }
  let version = cache.get(key);
  if (!version) {
    version = readVersion(pythonPath);
    cache.set(key, version);
    // A failed read (a timeout while the OS scans a fresh binary) is retried next time.
    void version.then((read) => {
      if (read === null) cache.delete(key);
    });
  }
  return version;
}

async function readVersion(pythonPath: string): Promise<string | null> {
  try {
    const proc = Bun.spawn([pythonPath, "--version"], {
      cwd: path.dirname(pythonPath),
      env: buildSpawnEnv(),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      timeout: VERSION_TIMEOUT_MS,
    });
    // Python 2 printed the version to stderr.
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return VERSION_RE.exec(`${stdout}\n${stderr}`)?.[1] ?? null;
  } catch (err) {
    log.debug("Could not read the Python version", { pythonPath, error: err });
    return null;
  }
}
