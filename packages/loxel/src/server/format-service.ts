import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import type { FileSink } from "bun";

import type { FormatterOverride, FormattingSettings } from "@/lib/formatting-model";

import type { BackendMode, FormatterBackend } from "./formatter-backends";
import {
  type FileFormatter,
  type FormatterSpawnOptions,
  type LanguageFormatter,
  nodeModulesBin,
} from "./language-formatter";
import { languageFormatters } from "./language-formatters";
import { logger } from "./logger";
import { OxfmtLspBackend } from "./oxfmt-lsp-backend";
import { PrettierLibBackend } from "./prettier-lib-backend";
import { buildSpawnEnv, refreshLoginShellEnv } from "./shell-env";
import { measureSpawn } from "./spawn-metrics";

const log = logger.child("format");

const MAX_FORMAT_SIZE = 1_024 * 1_024; // 1 MB
const FORMAT_TIMEOUT_MS = 5_000;

/**
 * Outcome of `FormatService.format()`. `content` is null when the file is saved unformatted;
 * `notice` then explains failures the user can fix (formatter not installed, timed out). Other
 * failures, typically a syntax error in the buffer that the language server already flags, only
 * go to the server log, since they would otherwise repeat on every save.
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
}

interface DetectionCache {
  /** Config file paths + mtimes at detection time. */
  fingerprint: string;
  formatters: DetectedFormatter[];
}

/** Config files oxfmt discovers on its own (see `oxfmt --help`, "Config Options"). */
const OXFMT_CONFIG_FILES = [
  ".oxfmtrc.json",
  ".oxfmtrc.jsonc",
  ".oxfmtrc.ts",
  ".oxfmtrc.mts",
  ".oxfmtrc.cts",
  ".oxfmtrc.js",
  ".oxfmtrc.mjs",
  ".oxfmtrc.cjs",
];

/**
 * Extensions both prettier and oxfmt format out of the box (verified against prettier 3.9
 * `--support-info` and oxfmt 0.68.0 via `--stdin-filepath` and `--lsp`). Alias spellings
 * (yml, mjs, scss, mdx, ...) are listed explicitly so that a project with both formatters
 * routes the whole language to the same formatter, not just the canonical extension.
 */
const SHARED_FORMAT_EXTENSIONS = [
  "ts",
  "tsx",
  "mts",
  "cts",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "css",
  "scss",
  "less",
  "json",
  "jsonc",
  "json5",
  "md",
  "mdx",
  "markdown",
  "yaml",
  "yml",
  "html",
  "vue",
  "graphql",
  "gql",
];

/** Config files to check and the formatter they imply. */
const DETECTION_RULES: {
  /** Config file paths relative to worktree root (globs not supported — exact names). */
  files: string[];
  /** Check function — receives worktree root, returns true if this formatter applies. */
  check: (wtRoot: string) => boolean;
  formatter: Omit<DetectedFormatter, "extensions"> & { extensions: string[] };
}[] = [
  // NOTE: backendMode is set per rule — "lsp" for oxfmt, "library" for prettier, "command" for others.
  // Rules are evaluated in array order and `format()` picks the first detected formatter whose
  // extension set contains the file's extension. Prettier is listed first, so when a project has
  // both a prettier config and oxfmt, prettier handles every extension it claims (e.g. `md`, `json`).
  {
    files: [
      ".prettierrc",
      ".prettierrc.json",
      ".prettierrc.yml",
      ".prettierrc.yaml",
      ".prettierrc.json5",
      ".prettierrc.toml",
      ".prettierrc.js",
      ".prettierrc.cjs",
      ".prettierrc.mjs",
      "prettier.config.js",
      "prettier.config.cjs",
      "prettier.config.mjs",
      "prettier.config.ts",
    ],
    check: (wtRoot) => {
      // Check config files
      for (const f of DETECTION_RULES[0]!.files) {
        if (existsSync(join(wtRoot, f))) return true;
      }
      // Check package.json for "prettier" key
      return packageJsonHasKey(wtRoot, "prettier");
    },
    formatter: {
      command: "prettier",
      args: "--stdin-filepath {file}",
      // `toml` is intentionally absent: prettier has no TOML support.
      extensions: [...SHARED_FORMAT_EXTENSIONS, "svelte", "astro"],
      backendMode: "library",
    },
  },
  {
    files: OXFMT_CONFIG_FILES,
    check: (wtRoot) => {
      if (OXFMT_CONFIG_FILES.some((f) => existsSync(join(wtRoot, f)))) return true;
      return packageJsonHasDep(wtRoot, "oxfmt");
    },
    formatter: {
      command: "oxfmt",
      args: "--stdin-filepath={file}",
      // Deliberately excluded (oxfmt 0.68.0): `svelte` (disabled unless the project enables the
      // `svelte` config option and installs `svelte`) and `astro` (unsupported).
      extensions: [...SHARED_FORMAT_EXTENSIONS, "toml"],
      backendMode: "lsp",
    },
  },
  {
    files: ["rustfmt.toml", ".rustfmt.toml"],
    check: (wtRoot) =>
      existsSync(join(wtRoot, "rustfmt.toml")) || existsSync(join(wtRoot, ".rustfmt.toml")),
    formatter: { command: "rustfmt", args: "", extensions: ["rs"], backendMode: "command" },
  },
  {
    files: [".clang-format"],
    check: (wtRoot) => existsSync(join(wtRoot, ".clang-format")),
    formatter: {
      command: "clang-format",
      args: "--assume-filename={file}",
      extensions: ["c", "cpp", "h", "hpp", "cc", "cxx"],
      backendMode: "command",
    },
  },
  {
    files: ["deno.json", "deno.jsonc"],
    check: (wtRoot) =>
      existsSync(join(wtRoot, "deno.json")) || existsSync(join(wtRoot, "deno.jsonc")),
    formatter: {
      command: "deno",
      args: "fmt --stdin --ext {ext}",
      extensions: ["ts", "tsx", "js", "jsx"],
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

  constructor(private readonly languages: readonly LanguageFormatter[] = languageFormatters) {}

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
      log.info("Formatting with manual override", { command: override.command, filePath });
      return this.runFormatter(override.command, override.args, content, filePath, worktreePath);
    }

    // 2. Auto-detect from project config
    const fmt =
      settings.autoDetect && worktreePath
        ? this.findDetectedFormatter(ext, filePath, worktreePath)
        : undefined;
    if (!fmt || !worktreePath) {
      log.debug("No formatter found", { filePath, ext });
      return UNFORMATTED;
    }
    log.info("Formatting with auto-detected formatter", { command: fmt.command, filePath });
    if (fmt.backendMode !== "command") {
      return this.formatWithBackend(fmt, content, filePath, worktreePath);
    }
    return this.runFormatter(fmt.command, fmt.args, content, filePath, worktreePath);
  }

  /**
   * Return detected formatters for a worktree (for settings UI). Language modules' formatters are
   * listed as detected for the worktree root; subprojects may resolve to a different one.
   */
  getDetectedFormatters(worktreePath: string): { command: string; extensions: string[] }[] {
    const formatters = [...this.detectFormatters(worktreePath)];
    for (const language of this.languages) {
      const detected = detectFormatter(language, worktreePath, worktreePath);
      if (detected) formatters.push(toDetectedFormatter(detected, language));
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
    for (const backend of this.backends.values()) {
      backend.destroy();
    }
    this.backends.clear();
  }

  // -------------------------------------------------------------------------
  // Private
  // -------------------------------------------------------------------------

  /**
   * The auto-detected formatter for a file: per file from the language modules claiming its
   * extension, else from the worktree root's config.
   */
  private findDetectedFormatter(
    ext: string,
    filePath: string,
    worktreePath: string,
  ): DetectedFormatter | undefined {
    const dir = fileDir(filePath, worktreePath);
    for (const language of this.languages) {
      const detected =
        language.extensions.includes(ext) && detectFormatter(language, dir, worktreePath);
      if (detected) return toDetectedFormatter(detected, language);
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
      binDirs: options?.binDirs ?? [nodeModulesBin(worktreePath)],
    };
  }

  private async formatWithBackend(
    fmt: DetectedFormatter,
    content: string,
    filePath: string,
    worktreePath: string,
  ): Promise<FormatResult> {
    const key = `${worktreePath}\0${fmt.command}`;
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

    const result = await backend.format(content, filePath);
    if (result !== null) return { content: result };

    // Backend failed — destroy and fall back to command mode for this request
    log.warn("Daemon formatter failed, falling back to command mode", { command: fmt.command });
    backend.destroy();
    this.backends.delete(key);
    return this.runFormatter(fmt.command, fmt.args, content, filePath, worktreePath);
  }

  private createBackend(
    fmt: DetectedFormatter,
    worktreePath: string,
  ): FormatterBackend | undefined {
    switch (fmt.command) {
      case "oxfmt":
        return new OxfmtLspBackend(worktreePath);
      case "prettier":
        return new PrettierLibBackend(worktreePath);
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
  ): Promise<FormatResult> {
    const ext = extractExtension(filePath) ?? "";
    const options = worktreePath
      ? await this.spawnOptions(command, ext, filePath, worktreePath)
      : {};
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
      return { content: null, notice: spawnFailureNotice(command, err, env.PATH ?? "") };
    }

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
        proc.kill();
        log.warn("Formatter timed out", { command, filePath });
        return {
          content: null,
          notice: `Format on save skipped: "${command}" timed out after ${FORMAT_TIMEOUT_MS / 1_000}s.`,
        };
      }

      if (exitCode !== 0) {
        const stderr = await new Response(proc.stderr).text();
        log.warn("Formatter exited with non-zero code", {
          command,
          filePath,
          exitCode,
          stderr: stderr.slice(0, 500),
        });
        return UNFORMATTED;
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
    }
  }
}

function spawnFormatter(
  argv: string[],
  cwd: string | undefined,
  env: Record<string, string | undefined>,
) {
  return measureSpawn("formatter", () =>
    Bun.spawn(argv, { stdin: "pipe", stdout: "pipe", stderr: "pipe", cwd, env }),
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
function spawnFailureNotice(command: string, err: unknown, PATH: string): string {
  const code = err instanceof Error && "code" in err ? String(err.code) : null;
  if (code === "ENOENT" && !Bun.which(command, { PATH })) {
    // It may have been installed since the login-shell PATH was captured; the next save retries.
    void refreshLoginShellEnv();
    return `Format on save skipped: "${command}" is not installed.`;
  }
  const detail = code === "ENOENT" ? "; its interpreter may be missing" : ` (${code ?? "error"})`;
  return `Format on save skipped: "${command}" could not be started${detail}.`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
): FileFormatter | null {
  try {
    return language.detect(dir, wtRoot);
  } catch (err) {
    log.warn("Formatter detection failed", { dir, error: errorMessage(err) });
    return null;
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function toDetectedFormatter(
  formatter: FileFormatter,
  language: LanguageFormatter,
): DetectedFormatter {
  return { ...formatter, extensions: new Set(language.extensions), backendMode: "command" };
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
  allConfigFiles.add("package.json"); // used for dep checks

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

/** Synchronously read and parse the worktree's package.json. Returns null if missing/invalid. */
function readPackageJson(wtRoot: string): Record<string, unknown> | null {
  const pkgPath = join(wtRoot, "package.json");
  if (!existsSync(pkgPath)) return null;
  try {
    const content = readFileSync(pkgPath, "utf-8");
    return JSON.parse(content) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Check if package.json has a top-level key. */
function packageJsonHasKey(wtRoot: string, key: string): boolean {
  const raw = readPackageJson(wtRoot);
  return raw !== null && key in raw;
}

/** Check if package.json has a dependency (any dep type). */
function packageJsonHasDep(wtRoot: string, pkg: string): boolean {
  const raw = readPackageJson(wtRoot);
  if (!raw) return false;
  const deps = raw.dependencies as Record<string, string> | undefined;
  const devDeps = raw.devDependencies as Record<string, string> | undefined;
  const peerDeps = raw.peerDependencies as Record<string, string> | undefined;
  return Boolean(deps?.[pkg] || devDeps?.[pkg] || peerDeps?.[pkg]);
}
