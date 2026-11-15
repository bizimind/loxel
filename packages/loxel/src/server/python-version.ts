import { stat } from "node:fs/promises";
import path from "node:path";

import type { PythonEnv } from "@/api/python-env-model";

import { logger } from "./logger";
import { untrustedInterpreter } from "./python-env";
import { isRepoTrusted } from "./repo-trust";
import { buildSpawnEnv } from "./shell-env";
import { measureSpawn } from "./spawn-metrics";

const log = logger.child("server");

const VERSION_TIMEOUT_MS = 5000;
const VERSION_RE = /Python (\d+\.\d+\S*)/;

/** Versions by interpreter path, the identity of the file it resolves to, and the directory asked from. */
const cache = new Map<string, Promise<string | null>>();

/**
 * The version of a Python interpreter (`3.12.13`), from `<python> --version`, or null when it
 * cannot be read. Cached until the interpreter file changes (an upgrade or a recreated venv);
 * failures are not cached.
 * Only pass interpreters the resolver accepted: this executes the file. CPython prints the
 * version before reading any configuration or importing `site`, so no project code runs.
 * A version-manager shim (pyenv, asdf) picks its Python by directory. In a trusted repository this
 * runs in the worktree, so a shim reports what the worktree selects. Otherwise it runs from the
 * filesystem root, so the worktree's files have no say, and a shim reports its global version;
 * and only an interpreter from outside the worktree and its environment runs
 * ({@link untrustedInterpreter}), so an environment's own binary (conda, Pixi) has no version.
 */
export async function pythonVersion(
  env: Pick<PythonEnv, "pythonPath" | "envPath">,
  wtPath: string,
): Promise<string | null> {
  const trusted = isRepoTrusted(wtPath);
  const pythonPath = trusted ? env.pythonPath : await untrustedInterpreter(env, wtPath);
  if (!pythonPath) return null;
  const cwd = trusted ? wtPath : path.parse(path.resolve(wtPath)).root;
  let key: string;
  try {
    const info = await stat(pythonPath);
    key = `${pythonPath}\0${info.dev}:${info.ino}:${info.mtimeMs}:${info.size}\0${cwd}`;
  } catch {
    return null;
  }
  let version = cache.get(key);
  if (!version) {
    version = readVersion(pythonPath, cwd);
    cache.set(key, version);
    // A failed read (a timeout while the OS scans a fresh binary) is retried next time.
    void version.then((read) => {
      if (read === null) cache.delete(key);
    });
  }
  return version;
}

async function readVersion(pythonPath: string, cwd: string): Promise<string | null> {
  try {
    const proc = measureSpawn("python-version", () =>
      Bun.spawn([pythonPath, "--version"], {
        cwd,
        env: buildSpawnEnv(),
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        timeout: VERSION_TIMEOUT_MS,
      }),
    );
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
