import { $ } from "bun";
import { rmSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import type { TsgoDiagnostic } from "@/api/diagnostics-model";

import { logger } from "./logger";
import { stress } from "./stress-detector";
import { resolveTsgoBinary } from "./tsgo-path";
import { INTERNAL_WORKTREE_PREFIX, REF_PATTERN, symlinkNodeModules } from "./worktree-utils";

const log = logger.child("ts-lsp");

const TSGO_TIMEOUT_MS = 30_000;

// In-memory cache keyed by commit hash (immutable — never needs invalidation)
const cache = new Map<string, TsgoDiagnostic[]>();
// In-flight requests deduplication — prevents concurrent worktree creation for the same ref
const inflight = new Map<string, Promise<TsgoDiagnostic[]>>();

/**
 * Get TypeScript diagnostics for a git ref by running tsgo in a detached worktree.
 * For working tree (ref undefined), runs tsgo directly in cwd.
 */
export async function getDiagnostics(
  cwd: string,
  ref: string | undefined,
): Promise<TsgoDiagnostic[]> {
  stress.track("diagnostics", { ref: ref ?? "__working_tree__" });
  // Working tree: run directly, no cache
  if (!ref) {
    return runTsgoInDir(cwd, cwd);
  }

  if (!REF_PATTERN.test(ref)) {
    throw new Error(`Invalid ref: ${ref}`);
  }

  const cached = cache.get(ref);
  if (cached) return cached;

  // Deduplicate concurrent requests for the same ref
  const existing = inflight.get(ref);
  if (existing) return existing;

  const promise = runDiagnosticsInWorktree(cwd, ref);
  inflight.set(ref, promise);
  try {
    return await promise;
  } finally {
    inflight.delete(ref);
  }
}

async function runDiagnosticsInWorktree(cwd: string, ref: string): Promise<TsgoDiagnostic[]> {
  const parentDir = (await $`mktemp -d`.text()).trim();
  const tmpDir = join(parentDir, `${INTERNAL_WORKTREE_PREFIX}diag-${ref.slice(0, 8)}`);

  try {
    // Create detached worktree at the ref
    await $`git -C ${cwd} worktree add --detach ${tmpDir} ${ref}`.quiet();

    // Symlink node_modules from main repo
    await symlinkNodeModules(cwd, tmpDir);

    const diagnostics = await runTsgoInDir(tmpDir, tmpDir);
    cache.set(ref, diagnostics);
    return diagnostics;
  } finally {
    // Cleanup worktree then temp directory
    try {
      await $`git -C ${cwd} worktree remove --force ${tmpDir}`.quiet();
    } catch {
      // Best-effort
    }
    try {
      rmSync(parentDir, { recursive: true, force: true });
    } catch {
      // Best-effort
    }
  }
}

/**
 * Run tsgo --noEmit in a directory and parse the output.
 */
async function runTsgoInDir(dir: string, stripPrefix: string): Promise<TsgoDiagnostic[]> {
  const tsgo = resolveTsgoBinary();
  if (!tsgo) {
    log.warn("tsgo binary not found; skipping diagnostics");
    return [];
  }
  try {
    const proc = Bun.spawn([tsgo, "--noEmit", "--pretty", "false"], {
      cwd: dir,
      env: { ...process.env, NO_COLOR: "1" },
      stdout: "pipe",
      stderr: "ignore",
    });

    // Race against timeout
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), TSGO_TIMEOUT_MS);
    });
    const exit = proc.exited;
    const winner = await Promise.race([exit, timeout]);

    if (winner === null) {
      proc.kill();
      await proc.exited;
      // Drain stdout to prevent pipe leak
      await new Response(proc.stdout).text().catch(() => {});
      return [];
    }

    clearTimeout(timer!);
    const output = await new Response(proc.stdout).text();
    if (!output.trim()) return [];

    return parseTsgoDiagnostics(output, stripPrefix);
  } catch {
    // tsgo not found or other spawn error
    return [];
  }
}

/**
 * Parse tsgo --pretty false output into structured diagnostics.
 * Format: `path(line,col): error TSxxxx: message`
 */
export function parseTsgoDiagnostics(output: string, stripPrefix: string): TsgoDiagnostic[] {
  const diagnostics: TsgoDiagnostic[] = [];
  const pattern = /^(.+)\((\d+),(\d+)\): (error|warning) TS(\d+): (.+)$/gm;

  let match: RegExpExecArray | null;
  while ((match = pattern.exec(output)) !== null) {
    const filePath = match[1]!;
    const line = match[2]!;
    const col = match[3]!;
    const severity = match[4]! as "error" | "warning";
    const code = match[5]!;
    const message = match[6]!;
    const relPath = relative(stripPrefix, resolve(stripPrefix, filePath));

    // Skip diagnostics from node_modules
    if (relPath.startsWith("node_modules")) continue;

    diagnostics.push({
      file: relPath,
      line: parseInt(line, 10),
      col: parseInt(col, 10),
      severity,
      code: parseInt(code, 10),
      message,
    });
  }

  return diagnostics;
}
