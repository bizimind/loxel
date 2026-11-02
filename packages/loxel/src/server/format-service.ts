import { existsSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import type { FileSink } from "bun";

import type { FormatterOverride, FormattingSettings } from "@/lib/formatting-model";

import { dotnetArgsRunProjectTool } from "./csharp-env";
import {
  type BackendMode,
  FORMAT_REJECTED,
  type FormatterBackend,
  killProcessGroup,
} from "./formatter-backends";
import {
  dirsUpToRoot,
  type FileFormatter,
  type FormatterDecline,
  type FormatterFailure,
  type FormatterSpawnOptions,
  type LanguageFormatter,
  projectNodeBinDirs,
} from "./language-formatter";
import { languageFormatters } from "./language-formatters";
import { logger } from "./logger";
import { OxfmtLspBackend } from "./oxfmt-lsp-backend";
import { PrettierLibBackend } from "./prettier-lib-backend";
import { isRepoTrusted, onRepoTrustChange, reportRepoRestriction } from "./repo-trust";
import { buildSpawnEnv, refreshLoginShellEnv } from "./shell-env";
import { measureSpawn } from "./spawn-metrics";

const log = logger.child("format");

const MAX_FORMAT_SIZE = 1_024 * 1_024; // 1 MB
const FORMAT_TIMEOUT_MS = 5_000;
const PREPARE_TIMEOUT_MS = 5_000;

/**
 * Outcome of `FormatService.format()`. `content` is null when the file is saved unformatted;
 * `notice` then explains failures the user can fix (formatter not installed, timed out), and what
 * a language module adds through `failureNotice`, a decline or `skip`. Other failures, typically a
 * syntax error in the buffer that the language server already flags, only go to the server log,
 * since they would otherwise repeat on every save.
 */
export interface FormatResult {
  content: string | null;
  notice?: string;
}

const UNFORMATTED: FormatResult = { content: null };

// ---------------------------------------------------------------------------
// Auto-detection rules
// ---------------------------------------------------------------------------

interface DetectedFormatter {
  command: string;
  args: string;
  extensions: Set<string>;
  backendMode: BackendMode;
  /** See {@link FileFormatter.backendDir}. */
  backendDir?: string;
  /** See {@link FileFormatter.backendToolDir}. */
  backendToolDir?: string;
  /** See {@link FileFormatter.prepare}. */
  prepare?: FileFormatter["prepare"];
  /** See {@link FileFormatter.spawn}. */
  spawn?: FileFormatter["spawn"];
}

interface DetectionCache {
  /** Config file paths + mtimes at detection time. */
  fingerprint: string;
  formatters: DetectedFormatter[];
}

/** Config files to check and the formatter they imply. */
const DETECTION_RULES: {
  /** Config file paths relative to worktree root (globs not supported — exact names). */
  files: string[];
  /** Check function — receives worktree root, returns true if this formatter applies. */
  check: (wtRoot: string) => boolean;
  formatter: Omit<DetectedFormatter, "extensions"> & { extensions: string[] };
}[] = [
  // Rules are evaluated in array order and `format()` picks the first detected formatter whose
  // extension set contains the file's extension.
  {
    files: ["deno.json", "deno.jsonc"],
    check: (wtRoot) =>
      existsSync(join(wtRoot, "deno.json")) || existsSync(join(wtRoot, "deno.jsonc")),
    formatter: {
      command: "deno",
      args: "fmt --ext {ext} -",
      extensions: ["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs"],
      backendMode: "command",
    },
  },
];

// ---------------------------------------------------------------------------
// FormatService
// ---------------------------------------------------------------------------

export class FormatService {
  private cacheByWorktree = new Map<string, DetectionCache>();
  private backends = new Map<string, FormatterBackend>();
  private running = new Set<{ worktreePath: string; pid: number; stopped: boolean }>();
  private readonly unsubscribeRepoTrust = onRepoTrustChange(() => this.stopUntrusted());

  constructor(
    private readonly languages: readonly LanguageFormatter[] = languageFormatters,
    private readonly prepareTimeoutMs = PREPARE_TIMEOUT_MS,
  ) {}

  /**
   * Format file content using the resolved formatter.
   * Returns null `content` if no formatter matched or formatting failed.
   */
  async format(
    content: string,
    filePath: string,
    worktreePath: string | undefined,
    settings: FormattingSettings,
  ): Promise<FormatResult> {
    if (!settings.enabled) return UNFORMATTED;
    if (content.length > MAX_FORMAT_SIZE) return UNFORMATTED;

    const ext = extractExtension(filePath);
    if (!ext) return UNFORMATTED;

    // 1. Check manual overrides first
    const override = findMatchingOverride(settings.overrides, ext);
    if (override) {
      // Overrides apply to every repository, and a relative path or a manifest names a different
      // file or tool in each.
      if (
        worktreePath &&
        !isRepoTrusted(worktreePath) &&
        (overrideNamesRepoPath(override, worktreePath) ||
          dotnetArgsRunProjectTool(
            override.command,
            override.args,
            dirsUpToRoot(fileDir(filePath, worktreePath), worktreePath),
          ))
      ) {
        const named = `${override.command} ${override.args}`.trim();
        log.info("Holding back an override that runs a project's file or tool", { filePath });
        reportRepoRestriction(
          worktreePath,
          `Format on save doesn't run ${named} from this repository.`,
        );
        return UNFORMATTED;
      }
      log.info("Formatting with manual override", { command: override.command, filePath });
      return this.runFormatter(override.command, override.args, content, filePath, worktreePath);
    }

    // 2. Auto-detect from project config
    const detected =
      settings.autoDetect && worktreePath
        ? this.findDetectedFormatter(ext, filePath, worktreePath)
        : undefined;
    const fmt = detected && (await prepareDetected(detected, filePath, this.prepareTimeoutMs));
    if (!fmt || !worktreePath) {
      log.debug("No formatter found", { filePath, ext });
      return UNFORMATTED;
    }
    if ("notice" in fmt) {
      log.info("Language module declined to format", { filePath, notice: fmt.notice });
      return { content: null, notice: fmt.notice };
    }
    log.info("Formatting with auto-detected formatter", { command: fmt.command, filePath });
    if (fmt.backendMode !== "command") {
      return this.formatWithBackend(fmt, content, filePath, worktreePath);
    }
    return this.runFormatter(fmt.command, fmt.args, content, filePath, worktreePath, fmt.spawn);
  }

  /**
   * Return detected formatters for a worktree (for settings UI). Language modules' formatters are
   * listed as detected for the worktree root; subprojects may resolve to a different one.
   */
  getDetectedFormatters(worktreePath: string): { command: string; extensions: string[] }[] {
    const formatters = [...this.detectFormatters(worktreePath)];
    for (const language of this.languages) {
      const detected = detectFormatter(language, worktreePath, worktreePath);
      if (detected && !("notice" in detected)) {
        formatters.push(toDetectedFormatter(detected, language));
      }
    }
    return formatters.map((f) => ({ command: f.command, extensions: [...f.extensions] }));
  }

  /** Invalidate the auto-detection cache and destroy backends for a worktree. */
  invalidateCache(worktreePath: string): void {
    this.cacheByWorktree.delete(worktreePath);
    const prefix = worktreePath + "\0";
    for (const [key, backend] of this.backends) {
      if (key.startsWith(prefix)) {
        backend.destroy();
        this.backends.delete(key);
      }
    }
  }

  /** Shut down all persistent formatter backends. */
  destroy(): void {
    this.unsubscribeRepoTrust();
    for (const run of this.running) killProcessGroup(run.pid);
    for (const backend of this.backends.values()) {
      backend.destroy();
    }
    this.backends.clear();
  }

  // -------------------------------------------------------------------------
  // Private
  // -------------------------------------------------------------------------

  /**
   * End what a repository that is no longer trusted has running: its backends, which hold its code
   * and config, and its formatters in flight. A save waiting on one goes out unformatted.
   */
  private stopUntrusted(): void {
    for (const [key, backend] of this.backends) {
      if (isRepoTrusted(key.slice(0, key.indexOf("\0")))) continue;
      backend.destroy();
      this.backends.delete(key);
    }
    for (const run of this.running) {
      if (isRepoTrusted(run.worktreePath)) continue;
      run.stopped = true;
      killProcessGroup(run.pid);
    }
  }

  /**
   * The auto-detected formatter for a file: per file from the language modules claiming its
   * extension, else from the worktree root's config. A module's decline ends the search.
   */
  private findDetectedFormatter(
    ext: string,
    filePath: string,
    worktreePath: string,
  ): DetectedFormatter | FormatterDecline | undefined {
    const dir = fileDir(filePath, worktreePath);
    for (const language of this.languages) {
      const detected =
        language.extensions.includes(ext) &&
        detectFormatter(language, dir, worktreePath, basename(filePath));
      if (detected) {
        return "notice" in detected ? detected : toDetectedFormatter(detected, language);
      }
    }
    return this.detectFormatters(worktreePath).find((f) => f.extensions.has(ext));
  }

  /** How to spawn `command` for a file: what its language module sets, over the defaults. */
  private async spawnOptions(
    command: string,
    ext: string,
    filePath: string,
    worktreePath: string,
  ): Promise<FormatterSpawnOptions> {
    const language = this.languages.find((l) => l.extensions.includes(ext));
    let options: FormatterSpawnOptions | undefined;
    try {
      options = await language?.spawnOptions?.(
        command,
        fileDir(filePath, worktreePath),
        worktreePath,
      );
    } catch (err) {
      // Formatting runs before the write: a module's failure must not lose the save.
      log.warn("Formatter spawn options failed", { command, filePath, error: errorMessage(err) });
    }
    return {
      ...options,
      cwd: options?.cwd ?? worktreePath,
      binDirs: options?.binDirs ?? projectNodeBinDirs(command, worktreePath),
    };
  }

  /** What the file's language module says about `failure`; its failure must not lose the save. */
  private languageNotice(ext: string, failure: FormatterFailure): string | undefined {
    try {
      return this.languages.find((l) => l.extensions.includes(ext))?.failureNotice?.(failure);
    } catch (err) {
      log.warn("Formatter failure notice failed", { ext, error: errorMessage(err) });
      return undefined;
    }
  }

  private async formatWithBackend(
    fmt: DetectedFormatter,
    content: string,
    filePath: string,
    worktreePath: string,
  ): Promise<FormatResult> {
    const key = [worktreePath, fmt.command, fmt.backendDir, fmt.backendToolDir].join("\0");
    let backend = this.backends.get(key);

    // Lazy start or restart on crash
    if (!backend || !backend.isAlive()) {
      if (backend) {
        backend.destroy();
        this.backends.delete(key);
      }
      backend = this.createBackend(fmt, worktreePath);
      if (!backend) {
        return this.runFormatter(fmt.command, fmt.args, content, filePath, worktreePath);
      }
      this.backends.set(key, backend);
    }

    const result = await backend.format(content, resolve(worktreePath, filePath));
    if (result === FORMAT_REJECTED) return UNFORMATTED;
    if (result !== null) return { content: result };

    // Backend failed — destroy and fall back to command mode for this request
    backend.destroy();
    // A concurrent save may have replaced it, and the replacement must stay reachable.
    if (this.backends.get(key) === backend) this.backends.delete(key);
    // Backends run only in a trusted repository, and the command would load the same config.
    if (!isRepoTrusted(worktreePath)) return UNFORMATTED;
    log.warn("Daemon formatter failed, falling back to command mode", { command: fmt.command });
    return this.runFormatter(fmt.command, fmt.args, content, filePath, worktreePath);
  }

  private createBackend(
    fmt: DetectedFormatter,
    worktreePath: string,
  ): FormatterBackend | undefined {
    const dir = fmt.backendDir ?? worktreePath;
    const toolDir = fmt.backendToolDir ?? dir;
    switch (fmt.command) {
      case "oxfmt":
        return new OxfmtLspBackend(dir, toolDir, worktreePath);
      case "prettier":
        return new PrettierLibBackend(dir, toolDir, worktreePath);
      default:
        return undefined;
    }
  }

  private detectFormatters(worktreePath: string): DetectedFormatter[] {
    // Check cache
    const fingerprint = computeFingerprint(worktreePath);
    const cached = this.cacheByWorktree.get(worktreePath);
    if (cached && cached.fingerprint === fingerprint) {
      return cached.formatters;
    }

    const formatters: DetectedFormatter[] = [];
    for (const rule of DETECTION_RULES) {
      if (rule.check(worktreePath)) {
        formatters.push({
          command: rule.formatter.command,
          args: rule.formatter.args,
          extensions: new Set(rule.formatter.extensions),
          backendMode: rule.formatter.backendMode,
        });
      }
    }

    this.cacheByWorktree.set(worktreePath, { fingerprint, formatters });
    if (formatters.length > 0) {
      log.info("Detected formatters", {
        worktreePath,
        formatters: formatters.map((f) => f.command).join(", "),
      });
    }
    return formatters;
  }

  private async runFormatter(
    command: string,
    argsTemplate: string,
    content: string,
    filePath: string,
    worktreePath: string | undefined,
    spawn?: FormatterSpawnOptions,
  ): Promise<FormatResult> {
    const ext = extractExtension(filePath) ?? "";
    const options =
      spawn ?? (worktreePath ? await this.spawnOptions(command, ext, filePath, worktreePath) : {});
    if (options.skip) {
      log.info("Language module skipped the formatter", { command, filePath });
      return { content: null, notice: options.skip.notice };
    }
    // Relative paths are relative to the worktree, so they would not survive another cwd.
    const fromWorktree = (path: string) =>
      worktreePath && options.cwd !== worktreePath ? resolve(worktreePath, path) : path;
    // Split template args first, then substitute placeholders in each element.
    // This prevents file paths with spaces from being split across arguments.
    const argv = [
      command.includes("/") ? fromWorktree(command) : command,
      ...splitArgs(argsTemplate).map((a) => substitutePlaceholders(a, fromWorktree(filePath), ext)),
    ].filter(Boolean);

    const env = { ...buildSpawnEnv(), ...options.env };
    // Project-local formatters win over global installs.
    if (options.binDirs?.length)
      env.PATH = [...options.binDirs, env.PATH].filter(Boolean).join(":");

    let proc: ReturnType<typeof spawnFormatter>;
    try {
      proc = spawnFormatter(argv, options.cwd, env);
    } catch (err) {
      log.warn("Formatter could not be started", { command, filePath, error: errorMessage(err) });
      const notice = spawnFailureNotice(command, err, env.PATH ?? "", (failure) =>
        this.languageNotice(ext, failure),
      );
      return { content: null, notice };
    }

    const run = worktreePath ? { worktreePath, pid: proc.pid, stopped: false } : null;
    if (run) this.running.add(run);
    try {
      feedStdin(proc.stdin, content, command);

      // Race between process completion and timeout
      const exitCode = await Promise.race([
        proc.exited,
        new Promise<"timeout">((resolve) => {
          setTimeout(() => resolve("timeout"), FORMAT_TIMEOUT_MS);
        }),
      ]);

      if (exitCode === "timeout") {
        killProcessGroup(proc.pid);
        log.warn("Formatter timed out", { command, filePath });
        return {
          content: null,
          notice: `Format on save skipped: "${command}" timed out after ${FORMAT_TIMEOUT_MS / 1_000}s.`,
        };
      }

      if (run?.stopped) return UNFORMATTED;

      if (exitCode !== 0) {
        const stderr = await new Response(proc.stderr).text();
        log.warn("Formatter exited with non-zero code", {
          command,
          filePath,
          exitCode,
          stderr: stderr.slice(0, 500),
        });
        const notice = this.languageNotice(ext, { kind: "exited", command, exitCode, stderr });
        return notice ? { content: null, notice } : UNFORMATTED;
      }

      const formatted = await new Response(proc.stdout).text();
      if (!formatted) {
        log.warn("Formatter produced empty output", { command, filePath });
        return UNFORMATTED;
      }

      return { content: formatted };
    } catch (err) {
      log.warn("Formatter failed", { command, filePath, error: errorMessage(err) });
      return UNFORMATTED;
    } finally {
      if (run) this.running.delete(run);
    }
  }
}

function spawnFormatter(
  argv: string[],
  cwd: string | undefined,
  env: Record<string, string | undefined>,
) {
  return measureSpawn("formatter", () =>
    Bun.spawn(argv, { stdin: "pipe", stdout: "pipe", stderr: "pipe", cwd, env, detached: true }),
  );
}

/**
 * Write `content` to a formatter's stdin without waiting for it to be read. A formatter that exits
 * first (`EPIPE`, thrown or as a rejection depending on how much was buffered) is not a failure of
 * its own: its exit code and output still decide the result. Other errors throw or get logged.
 */
function feedStdin(stdin: FileSink, content: string, command: string): void {
  const logRejection = (err: unknown) => {
    if (!isClosedPipe(err))
      log.warn("Formatter stdin failed", { command, error: errorMessage(err) });
  };
  try {
    for (const step of [() => stdin.write(content), () => stdin.end()]) {
      const pending = step();
      if (pending instanceof Promise) pending.catch(logRejection);
    }
  } catch (err) {
    if (!isClosedPipe(err)) throw err;
  }
}

function isClosedPipe(err: unknown): boolean {
  return err instanceof Error && "code" in err && err.code === "EPIPE";
}

/**
 * Why a formatter could not be started, for the user: any spawn error is one they can fix.
 * Bun.spawn throws ENOENT both when the executable is not on PATH and when it is found but its
 * interpreter is gone (e.g. a venv whose Python was upgraded away).
 */
function spawnFailureNotice(
  command: string,
  err: unknown,
  PATH: string,
  languageNotice: (failure: FormatterFailure) => string | undefined,
): string {
  const code = err instanceof Error && "code" in err ? String(err.code) : null;
  if (code === "ENOENT" && !Bun.which(command, { PATH })) {
    // It may have been installed since the login-shell PATH was captured; the next save retries.
    void refreshLoginShellEnv();
    return (
      languageNotice({ kind: "not-installed", command }) ??
      `Format on save skipped: "${command}" is not installed.`
    );
  }
  const detail = code === "ENOENT" ? "; its interpreter may be missing" : ` (${code ?? "error"})`;
  return `Format on save skipped: "${command}" could not be started${detail}.`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A command with a directory in it that isn't absolute, which resolves against the worktree. */
function isRelativePath(command: string): boolean {
  return command.includes("/") && !isAbsolute(command);
}

/**
 * Whether an override's command or an argument names a path in the worktree it runs in: `node
 * tools/fmt.js {file}` runs the repository's script as surely as `tools/fmt.js` does. The saved
 * file's own `{file}` doesn't count, and a value is read from `--flag=value`.
 */
function overrideNamesRepoPath(override: FormatterOverride, worktreePath: string): boolean {
  if (isRelativePath(override.command)) return true;
  return splitArgs(override.args).some((arg) => {
    if (arg.includes("{file}")) return false;
    const value = arg.startsWith("-") ? arg.split("=").slice(1).join("=") : arg;
    if (value === "" || isAbsolute(value)) return false;
    return isRelativePath(value) || existsSync(resolve(worktreePath, value));
  });
}

function extractExtension(filePath: string): string | null {
  const lastSlash = filePath.lastIndexOf("/");
  const basename = filePath.slice(lastSlash + 1);
  const dotIdx = basename.lastIndexOf(".");
  if (dotIdx <= 0) return null;
  return basename.slice(dotIdx + 1).toLowerCase();
}

/** Directory of `filePath`, which is absolute or relative to the worktree. */
function fileDir(filePath: string, worktreePath: string): string {
  return dirname(resolve(worktreePath, filePath));
}

/** A module's `detect`; one that throws detects nothing, since formatting runs before the write. */
function detectFormatter(
  language: LanguageFormatter,
  dir: string,
  wtRoot: string,
  fileName?: string,
): FileFormatter | FormatterDecline | null {
  try {
    return language.detect(dir, wtRoot, fileName);
  } catch (err) {
    log.warn("Formatter detection failed", { dir, error: errorMessage(err) });
    return null;
  }
}

/**
 * A detected formatter after its `prepare`; one that throws detects nothing, like `detect`. The whole
 * of it is capped, as a save is waiting. What it leaves running can still finish and be remembered.
 */
async function prepareDetected(
  detected: DetectedFormatter | FormatterDecline,
  filePath: string,
  timeoutMs: number,
): Promise<DetectedFormatter | FormatterDecline | undefined> {
  if ("notice" in detected || !detected.prepare) return detected;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<FormatterDecline>((done) => {
    timer = setTimeout(
      () =>
        done({
          notice: `Format on save skipped: checking "${detected.command}" took too long. The next save tries again.`,
        }),
      timeoutMs,
    );
  });
  try {
    const prepared = await Promise.race([detected.prepare(), timedOut]);
    return "notice" in prepared ? prepared : { ...detected, ...prepared, prepare: undefined };
  } catch (err) {
    log.warn("Preparing a formatter failed", { filePath, error: errorMessage(err) });
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function toDetectedFormatter(
  formatter: FileFormatter,
  language: LanguageFormatter,
): DetectedFormatter {
  return {
    ...formatter,
    extensions: new Set(language.extensions),
    backendMode: formatter.backendMode ?? "command",
  };
}

function findMatchingOverride(
  overrides: FormatterOverride[],
  ext: string,
): FormatterOverride | undefined {
  return overrides.find((o) => {
    const exts = o.extensions.split(",").map((e) => e.trim().toLowerCase());
    return exts.includes(ext);
  });
}

function substitutePlaceholders(args: string, filePath: string, ext: string): string {
  return args.replace(/\{file\}/g, filePath).replace(/\{ext\}/g, ext);
}

/** Simple arg splitting — split on whitespace. Does not handle quotes. */
function splitArgs(args: string): string[] {
  return args.split(/\s+/).filter(Boolean);
}

/**
 * Compute a fingerprint for auto-detection cache based on config file existence + mtime.
 * Uses `existsSync` + `statSync` since `Bun.file()` returns lazy refs that don't throw
 * for missing files (size=0, lastModified=sentinel).
 */
function computeFingerprint(worktreePath: string): string {
  const parts: string[] = [];
  const allConfigFiles = new Set<string>();
  for (const rule of DETECTION_RULES) {
    for (const f of rule.files) {
      allConfigFiles.add(f);
    }
  }

  for (const f of [...allConfigFiles].sort()) {
    const fullPath = join(worktreePath, f);
    if (existsSync(fullPath)) {
      try {
        const stat = statSync(fullPath);
        parts.push(`${f}:${stat.size}:${stat.mtimeMs}`);
      } catch {
        parts.push(`${f}:err`);
      }
    } else {
      parts.push(`${f}:absent`);
    }
  }
  return parts.join("|");
}
