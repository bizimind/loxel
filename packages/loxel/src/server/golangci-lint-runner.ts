/** One `golangci-lint run`, and checking the installed binary's version. */
import { statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseGolangciLintReport, type GolangciLintReport } from "./golangci-lint-diagnostics";
import { logger } from "./logger";
import { measureSpawn } from "./spawn-metrics";

const log = logger.child("golangci-lint-lsp");

const VERSION_TIMEOUT_MS = 10_000;
/** golangci-lint stops itself after `--timeout`; this is for one that does not. */
const RUN_TIMEOUT_MS = 5.5 * 60_000;
const VERSION_OUTPUT = /has version v?(\d+)\.(\d+)/;

const EXIT = { clean: 0, issues: 1, configError: 3, timeout: 4, noGoFiles: 5, errorLogged: 7 };

export interface GolangciLintRun {
  binary: string;
  /** The module directory it runs in. */
  cwd: string;
  config: string;
  /** Package directories, as `./rel/dir/`. */
  targets: readonly string[];
  env: Record<string, string | undefined>;
  signal: AbortSignal;
}

export type GolangciLintOutcome =
  /** The report, for a run that got through. `Report.error` may still name part it left out. */
  | { kind: "reported"; report: GolangciLintReport }
  /** Exit 3: what it said about the config or its flags. */
  | { kind: "config-error"; message: string }
  /** Nothing to go on: the previous diagnostics stand. */
  | { kind: "inconclusive" }
  | { kind: "stopped" };

/** Whether the binary can run: read once per file, and false when it does not say. */
const supportedBinaries = new Map<string, { identity: string; supported: boolean }>();

export async function isSupportedGolangciLint(
  binary: string,
  env: Record<string, string | undefined>,
): Promise<boolean> {
  const identity = fileIdentity(binary);
  const cached = supportedBinaries.get(binary);
  if (cached && cached.identity === identity) return cached.supported;
  const version = await readVersion(binary, env);
  if (!version) return false;
  // `--path-mode` arrived in 2.1.
  const supported = version.major === 2 && version.minor >= 1;
  supportedBinaries.set(binary, { identity, supported });
  return supported;
}

async function readVersion(
  binary: string,
  env: Record<string, string | undefined>,
): Promise<{ major: number; minor: number } | null> {
  try {
    const { stdout } = await spawnInGroup([binary, "--version"], {
      cwd: "/",
      env,
      timeoutMs: VERSION_TIMEOUT_MS,
    });
    const found = VERSION_OUTPUT.exec(stdout);
    log.info("Using golangci-lint", { binary, version: stdout.trim().slice(0, 80) });
    return found ? { major: Number(found[1]), minor: Number(found[2]) } : null;
  } catch (err) {
    log.warn("Could not read the golangci-lint version", { binary, error: err });
    return null;
  }
}

function fileIdentity(file: string): string {
  try {
    const { dev, ino, size, mtimeMs } = statSync(file);
    return `${dev}:${ino}:${size}:${mtimeMs}`;
  } catch {
    return "";
  }
}

/**
 * Run golangci-lint on `targets`. The report goes to a private temporary file, since stdout also
 * carries whatever formats the project's config asks for.
 */
export async function runGolangciLint(run: GolangciLintRun): Promise<GolangciLintOutcome> {
  const reportDir = await mkdtemp(join(tmpdir(), "loxel-golangci-lint-"));
  try {
    return await runInto(run, join(reportDir, "report.json"));
  } finally {
    await rm(reportDir, { recursive: true, force: true });
  }
}

async function runInto(run: GolangciLintRun, reportPath: string): Promise<GolangciLintOutcome> {
  if (run.signal.aborted) return { kind: "stopped" };
  let exit: ToolExit;
  try {
    exit = await spawnInGroup(
      [
        run.binary,
        "run",
        "--config",
        run.config,
        "--output.json.path",
        reportPath,
        "--show-stats=false",
        "--fix=false",
        // A config's own value would make the exit code say nothing.
        "--issues-exit-code=1",
        "--allow-parallel-runners",
        "--path-mode",
        "abs",
        "--path-prefix",
        "",
        "--max-issues-per-linter=0",
        "--max-same-issues=0",
        "--timeout",
        "5m",
        ...run.targets,
      ],
      { cwd: run.cwd, env: run.env, timeoutMs: RUN_TIMEOUT_MS, signal: run.signal },
    );
  } catch (err) {
    // Its module went away meanwhile, as in a checkout.
    log.warn("Could not start golangci-lint", { cwd: run.cwd, error: err });
    return { kind: "inconclusive" };
  }
  const { exitCode, stderr } = exit;
  if (run.signal.aborted) return { kind: "stopped" };
  if (exitCode === EXIT.configError) return { kind: "config-error", message: firstLine(stderr) };
  // Exit 7 still writes a report, which says why; one with no error in it proves nothing.
  if (exitCode === EXIT.clean || exitCode === EXIT.issues || exitCode === EXIT.errorLogged) {
    const report = parseGolangciLintReport(await readReport(reportPath));
    if (report && (exitCode !== EXIT.errorLogged || report.error)) {
      return { kind: "reported", report };
    }
  }
  if (exitCode !== EXIT.noGoFiles) {
    log.warn("golangci-lint gave no usable report", {
      cwd: run.cwd,
      exitCode,
      timedOut: exitCode === EXIT.timeout,
      stderr: firstLine(stderr),
    });
  }
  return { kind: "inconclusive" };
}

interface ToolExit {
  /** Null when a signal ended it. */
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Runs in a process group of its own, killed whole on a timeout, on `signal` and once it has exited:
 * something it started and left behind would otherwise hold the pipes this waits on, and every other
 * run waits on this one.
 */
async function spawnInGroup(
  command: string[],
  options: {
    cwd: string;
    env: Record<string, string | undefined>;
    timeoutMs: number;
    signal?: AbortSignal;
  },
): Promise<ToolExit> {
  const proc = measureSpawn("golangci-lint", () =>
    Bun.spawn(command, {
      cwd: options.cwd,
      env: options.env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      detached: true,
    }),
  );
  const killGroup = (): void => {
    try {
      process.kill(-proc.pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  };
  const timer = setTimeout(killGroup, options.timeoutMs);
  options.signal?.addEventListener("abort", killGroup, { once: true });
  try {
    void proc.exited.then(killGroup);
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { exitCode: proc.signalCode ? null : exitCode, stdout, stderr };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", killGroup);
  }
}

async function readReport(path: string): Promise<string> {
  try {
    return await Bun.file(path).text();
  } catch {
    return "";
  }
}

/** What stderr says went wrong, without the logger's or cobra's wrapping. */
function firstLine(stderr: string): string {
  const lines = stderr.split("\n").filter((entry) => entry.trim());
  const line = lines.find((entry) => /^Error:|\blevel=error\b/.test(entry)) ?? lines[0] ?? "";
  const logged = /\bmsg="((?:[^"\\]|\\.)*)"/.exec(line)?.[1];
  return (logged ?? line).replace(/^Error:\s*/, "").trim();
}
