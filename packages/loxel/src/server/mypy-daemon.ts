/**
 * One mypy daemon (`dmypy`) for one mypy config root, run from the worktree's Python environment,
 * and the parsing of its reports into language-server diagnostics.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { Subprocess } from "bun";

import { isRecord } from "@/lib/is-record";

import { logger } from "./logger";

const log = logger.child("mypy-lsp");

/** An idle daemon exits on its own after this long, so one Loxel could not stop does not linger. */
const DAEMON_IDLE_TIMEOUT_S = 3600;
/** First mypy release with `--output json`; older ones are read in their text format. */
const MIN_JSON_VERSION = "1.11.0";
const VERSION_TIMEOUT_MS = 10_000;
/** Where mypy documents each error code. */
const ERROR_CODE_DOCS = "https://mypy.readthedocs.io/en/stable/_refs.html#code-";

const SEVERITY = { error: 1, warning: 2, note: 3 } as const;

/** A language-server diagnostic, as `textDocument/publishDiagnostics` carries it. */
export interface MypyDiagnostic {
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
  severity: (typeof SEVERITY)[keyof typeof SEVERITY];
  source: "mypy";
  message: string;
  code?: string;
  codeDescription?: { href: string };
}

export interface MypyRunResult {
  /** Diagnostics by absolute file path; files without any are absent. */
  diagnostics: Map<string, MypyDiagnostic[]>;
  /** What mypy said when it could not check the project (a config error, a crash), else null. */
  failure: string | null;
}

export interface MypyDaemonOptions {
  /** Directory of the mypy config, where mypy runs. */
  root: string;
  /** The environment's `dmypy`. */
  dmypy: string;
  /** Spawn environment, with the Python environment activated. */
  env: Record<string, string | undefined>;
  /** Distinguishes the daemons of different worktrees sharing a root path over time. */
  owner: string;
}

/**
 * A mypy daemon for one config root. The daemon starts with the first {@link run} (`dmypy run`
 * starts it, and restarts it when mypy's options change) and keeps its state between runs, so a
 * re-check after an edit only analyzes what changed. Its status file lives outside the project, so
 * nothing is written there but mypy's own `.mypy_cache`.
 */
export class MypyDaemon {
  readonly root: string;
  private readonly statusFile: string;
  private running: Subprocess | null = null;
  private jsonOutput: Promise<boolean> | null = null;
  private stopped = false;

  constructor(private readonly options: MypyDaemonOptions) {
    this.root = options.root;
    const id = createHash("sha256").update(`${options.owner}\0${options.root}`).digest("hex");
    this.statusFile = path.join(tmpdir(), "loxel-dmypy", `${id.slice(0, 16)}.json`);
  }

  /**
   * Check `targets` (paths relative to the root; none: what the config names) and return the
   * diagnostics, or null when the daemon was stopped meanwhile.
   */
  async run(targets: readonly string[]): Promise<MypyRunResult | null> {
    const json = await (this.jsonOutput ??= this.supportsJsonOutput());
    if (this.stopped) return null;
    mkdirSync(path.dirname(this.statusFile), { recursive: true });
    const flags = json
      ? ["--output", "json", "--show-error-end"]
      : [
          "--show-column-numbers",
          "--show-error-end",
          "--show-error-codes",
          "--no-pretty",
          "--no-error-summary",
          "--no-color-output",
        ];
    const proc = Bun.spawn(
      [
        this.options.dmypy,
        "--status-file",
        this.statusFile,
        "run",
        "--timeout",
        String(DAEMON_IDLE_TIMEOUT_S),
        "--",
        ...flags,
        ...targets,
      ],
      {
        cwd: this.root,
        env: this.options.env,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    this.running = proc;
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (this.running === proc) this.running = null;
    if (this.stopped) {
      // A run stopped while it started the daemon may have left one behind.
      this.killDaemon();
      return null;
    }
    // A plugin that fails to load is reported on stderr, as an error against the config file.
    const { diagnostics, otherLines } = parseMypyOutput(`${stdout}\n${stderr}`, this.root, json);
    // 0: no errors, 1: errors found, 2: mypy could not check (a config error, a crash).
    if (exitCode === 0 || exitCode === 1) return { diagnostics, failure: null };
    const said = otherLines
      .map((line) => line.trim())
      .filter((line) => line && !DAEMON_CHATTER.test(line));
    const errors = [...diagnostics.values()]
      .flat()
      .filter((d) => d.severity === SEVERITY.error)
      .map((d) => d.message);
    const failure = [...said, ...errors].join("\n") || `dmypy exited with code ${exitCode}`;
    log.warn("mypy could not check the project", { root: this.root, exitCode, failure });
    return { diagnostics, failure };
  }

  /**
   * Stop the daemon and any run in flight. `dmypy run` detaches the daemon, so it is stopped
   * through the pid in its status file, as `dmypy kill` does.
   */
  stop(): void {
    this.stopped = true;
    this.running?.kill();
    this.running = null;
    this.killDaemon();
  }

  private killDaemon(): void {
    let pid: unknown;
    try {
      const status: unknown = JSON.parse(readFileSync(this.statusFile, "utf-8"));
      pid = isRecord(status) ? status.pid : undefined;
    } catch {
      return;
    }
    if (typeof pid === "number" && pid > 0) {
      try {
        process.kill(pid);
      } catch {
        // Already gone.
      }
    }
    rmSync(this.statusFile, { force: true });
  }

  private async supportsJsonOutput(): Promise<boolean> {
    try {
      const proc = Bun.spawn([this.options.dmypy, "--version"], {
        cwd: this.root,
        env: this.options.env,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "ignore",
        timeout: VERSION_TIMEOUT_MS,
      });
      const [stdout] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
      const version = /(\d+\.\d+(?:\.\d+)?)/.exec(stdout)?.[1];
      log.info("Using mypy", { root: this.root, dmypy: this.options.dmypy, version });
      return version !== undefined && Bun.semver.order(version, MIN_JSON_VERSION) >= 0;
    } catch (err) {
      log.warn("Could not read the mypy version", { dmypy: this.options.dmypy, error: err });
      return false;
    }
  }
}

/** What `dmypy run` prints about the daemon itself. */
const DAEMON_CHATTER = /^(Daemon (started|stopped)|Restarting: )/;

/** `path:line:col:end_line:end_col: severity: message  [code]`, mypy's text format with error ends. */
const TEXT_LINE =
  /^(.+?):(\d+):(\d+):(\d+):(\d+): (error|warning|note): (.*?)(?: {2}\[([a-z0-9-]+)\])?$/;

/**
 * Parse `dmypy run` output (JSON lines, or the text format with column numbers and error ends)
 * into diagnostics by absolute path, plus the lines that are not reports.
 */
export function parseMypyOutput(
  stdout: string,
  root: string,
  json: boolean,
): { diagnostics: Map<string, MypyDiagnostic[]>; otherLines: string[] } {
  const diagnostics = new Map<string, MypyDiagnostic[]>();
  const otherLines: string[] = [];
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    const report = json ? parseJsonLine(line) : parseTextLine(line);
    if (!report) {
      otherLines.push(line);
      continue;
    }
    // Reports without a position (`In function "f":` context lines) have no place in the editor.
    if (report.line < 1) continue;
    const file = path.resolve(root, report.file);
    const list = diagnostics.get(file) ?? [];
    list.push(toDiagnostic(report));
    diagnostics.set(file, list);
  }
  return { diagnostics, otherLines };
}

/** One mypy report, with 1-based lines and 0-based columns (end exclusive). */
interface MypyReport {
  file: string;
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
  severity: keyof typeof SEVERITY;
  message: string;
  code: string | null;
}

function parseJsonLine(line: string): MypyReport | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;
  const { file, line: row, column, message, hint, code, severity } = value;
  if (typeof file !== "string" || typeof row !== "number" || typeof message !== "string") {
    return null;
  }
  const col = typeof column === "number" ? column : 0;
  return {
    file,
    line: row,
    column: col,
    endLine: typeof value.end_line === "number" ? value.end_line : row,
    endColumn: typeof value.end_column === "number" ? value.end_column : col,
    severity: isSeverity(severity) ? severity : "error",
    // Notes mypy attaches to a report, such as where its docs explain a missing import.
    message: typeof hint === "string" && hint ? `${message}\n${hint}` : message,
    code: typeof code === "string" ? code : null,
  };
}

function parseTextLine(line: string): MypyReport | null {
  const match = TEXT_LINE.exec(line);
  if (!match) return null;
  const [, file = "", row, col, endRow, endCol, severity, message = "", code] = match;
  return {
    file,
    line: Number(row),
    // Text columns are 1-based; an end column is inclusive, which makes it the exclusive end.
    column: Number(col) - 1,
    endLine: Number(endRow),
    endColumn: Number(endCol),
    severity: isSeverity(severity) ? severity : "error",
    message,
    code: code ?? null,
  };
}

function isSeverity(value: unknown): value is keyof typeof SEVERITY {
  return value === "error" || value === "warning" || value === "note";
}

function toDiagnostic(report: MypyReport): MypyDiagnostic {
  const start = { line: report.line - 1, character: Math.max(0, report.column) };
  const endLine = Math.max(report.endLine - 1, start.line);
  const end = {
    line: endLine,
    character:
      endLine === start.line ? Math.max(report.endColumn, start.character) : report.endColumn,
  };
  const diagnostic: MypyDiagnostic = {
    range: { start, end },
    severity: SEVERITY[report.severity],
    source: "mypy",
    message: report.message,
  };
  if (report.code) {
    diagnostic.code = report.code;
    diagnostic.codeDescription = { href: `${ERROR_CODE_DOCS}${report.code}` };
  }
  return diagnostic;
}
