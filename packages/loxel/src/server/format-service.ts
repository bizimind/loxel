import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import type { FormatterOverride, FormattingSettings } from "@/lib/formatting-model";

import type { BackendMode, FormatterBackend } from "./formatter-backends";
import { logger } from "./logger";
import { OxfmtLspBackend } from "./oxfmt-lsp-backend";
import { PrettierLibBackend } from "./prettier-lib-backend";
import { buildSpawnEnv } from "./shell-env";

const log = logger.child("format");

const MAX_FORMAT_SIZE = 1_024 * 1_024; // 1 MB
const FORMAT_TIMEOUT_MS = 5_000;

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

/** Config files to check and the formatter they imply. */
const DETECTION_RULES: {
  /** Config file paths relative to worktree root (globs not supported — exact names). */
  files: string[];
  /** Check function — receives worktree root, returns true if this formatter applies. */
  check: (wtRoot: string) => boolean;
  formatter: Omit<DetectedFormatter, "extensions"> & { extensions: string[] };
}[] = [
  // NOTE: backendMode is set per rule — "lsp" for oxfmt, "library" for prettier, "command" for others
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
      extensions: [
        "ts",
        "tsx",
        "js",
        "jsx",
        "css",
        "json",
        "md",
        "yaml",
        "html",
        "vue",
        "svelte",
        "astro",
      ],
      backendMode: "library",
    },
  },
  {
    files: ["oxfmt.toml"],
    check: (wtRoot) => {
      if (existsSync(join(wtRoot, "oxfmt.toml"))) return true;
      return packageJsonHasDep(wtRoot, "oxfmt");
    },
    formatter: {
      command: "oxfmt",
      args: "--stdin-filepath={file}",
      extensions: ["ts", "tsx", "js", "jsx", "css"],
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
    files: ["pyproject.toml"],
    check: (wtRoot) => existsSync(join(wtRoot, "pyproject.toml")),
    formatter: {
      command: "ruff",
      args: "format --stdin-filename {file}",
      extensions: ["py"],
      backendMode: "command",
    },
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

  /**
   * Format file content using the resolved formatter.
   * Returns the formatted content, or `null` if no formatter matched or formatting failed.
   */
  async format(
    content: string,
    filePath: string,
    worktreePath: string | undefined,
    settings: FormattingSettings,
  ): Promise<string | null> {
    if (!settings.enabled) return null;
    if (content.length > MAX_FORMAT_SIZE) return null;

    const ext = extractExtension(filePath);
    if (!ext) return null;

    // 1. Check manual overrides first
    const override = findMatchingOverride(settings.overrides, ext);
    if (override) {
      log.info("Formatting with manual override", { command: override.command, filePath });
      return this.runFormatter(override.command, override.args, content, filePath, worktreePath);
    }

    // 2. Auto-detect from project config
    if (settings.autoDetect && worktreePath) {
      const detected = this.detectFormatters(worktreePath);
      for (const fmt of detected) {
        if (fmt.extensions.has(ext)) {
          log.info("Formatting with auto-detected formatter", { command: fmt.command, filePath });
          if (fmt.backendMode !== "command") {
            return this.formatWithBackend(fmt, content, filePath, worktreePath);
          }
          return this.runFormatter(fmt.command, fmt.args, content, filePath, worktreePath);
        }
      }
    }

    log.debug("No formatter found", { filePath, ext });
    return null;
  }

  /** Return detected formatters for a worktree (for settings UI). */
  getDetectedFormatters(worktreePath: string): { command: string; extensions: string[] }[] {
    return this.detectFormatters(worktreePath).map((f) => ({
      command: f.command,
      extensions: [...f.extensions],
    }));
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

  private async formatWithBackend(
    fmt: DetectedFormatter,
    content: string,
    filePath: string,
    worktreePath: string,
  ): Promise<string | null> {
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
    if (result !== null) return result;

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
  ): Promise<string | null> {
    const ext = extractExtension(filePath) ?? "";
    // Split template args first, then substitute placeholders in each element.
    // This prevents file paths with spaces from being split across arguments.
    const argv = [
      command,
      ...splitArgs(argsTemplate).map((a) => substitutePlaceholders(a, filePath, ext)),
    ].filter(Boolean);

    const env = buildSpawnEnv();
    // Prepend node_modules/.bin for project-local formatters
    if (worktreePath) {
      const localBin = join(worktreePath, "node_modules", ".bin");
      env.PATH = env.PATH ? `${localBin}:${env.PATH}` : localBin;
    }

    try {
      const proc = Bun.spawn(argv, {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        cwd: worktreePath ?? undefined,
        env,
      });

      // Write content to stdin
      proc.stdin.write(content);
      proc.stdin.end();

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
        return null;
      }

      if (exitCode !== 0) {
        const stderr = await new Response(proc.stderr).text();
        log.warn("Formatter exited with non-zero code", {
          command,
          filePath,
          exitCode,
          stderr: stderr.slice(0, 500),
        });
        return null;
      }

      const formatted = await new Response(proc.stdout).text();
      if (!formatted) {
        log.warn("Formatter produced empty output", { command, filePath });
        return null;
      }

      return formatted;
    } catch (err) {
      log.warn("Formatter failed to execute", {
        command,
        filePath,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }
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
