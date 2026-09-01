import { $ } from "bun";
import { rmSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import type { TypeScriptDiagnostic } from "@/api/diagnostics-model";

import { logger } from "./logger";
import { stress } from "./stress-detector";
import { resolveTypeScriptBinary } from "./typescript-path";
import { INTERNAL_WORKTREE_PREFIX, REF_PATTERN, symlinkNodeModules } from "./worktree-utils";

const log = logger.child("ts-lsp");

const TSC_TIMEOUT_MS = 30_000;

// In-memory cache keyed by commit hash (immutable — never needs invalidation)
const cache = new Map<string, TypeScriptDiagnostic[]>();
// In-flight requests deduplication — prevents concurrent worktree creation for the same ref
const inflight = new Map<string, Promise<TypeScriptDiagnostic[]>>();

/**
 * Get TypeScript diagnostics for a git ref by running TypeScript in a detached worktree.
 * For working tree (ref undefined), runs TypeScript directly in cwd.
 */
export async function getDiagnostics(
  cwd: string,
  ref: string | undefined,
): Promise<TypeScriptDiagnostic[]> {
  stress.track("diagnostics", { ref: ref ?? "__working_tree__" });
  // Working tree: run directly, no cache
  if (!ref) {
    return runTypeScriptInDir(cwd, cwd);
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

async function runDiagnosticsInWorktree(cwd: string, ref: string): Promise<TypeScriptDiagnostic[]> {
  const parentDir = (await $`mktemp -d`.text()).trim();
  const tmpDir = join(parentDir, `${INTERNAL_WORKTREE_PREFIX}diag-${ref.slice(0, 8)}`);

  try {
    // Create detached worktree at the ref
    await $`git -C ${cwd} worktree add --detach ${tmpDir} ${ref}`.quiet();

    // Symlink node_modules from main repo
    await symlinkNodeModules(cwd, tmpDir);

    const diagnostics = await runTypeScriptInDir(tmpDir, tmpDir);
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
 * Run TypeScript with --noEmit in a directory and parse the output.
 */
async function runTypeScriptInDir(
  dir: string,
  stripPrefix: string,
): Promise<TypeScriptDiagnostic[]> {
  const tsc = resolveTypeScriptBinary();
  if (!tsc) {
    log.warn("TypeScript compiler not found; skipping diagnostics");
    return [];
  }
  try {
    const proc = Bun.spawn([tsc, "--noEmit", "--pretty", "false"], {
      cwd: dir,
      env: { ...process.env, NO_COLOR: "1" },
      stdout: "pipe",
      stderr: "ignore",
    });

    // Race against timeout
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), TSC_TIMEOUT_MS);
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

    return parseTypeScriptDiagnostics(output, stripPrefix);
  } catch {
    // TypeScript compiler not found or other spawn error
    return [];
  }
}

/**
 * Parse TypeScript --pretty false output into structured diagnostics.
 * Format: `path(line,col): error TSxxxx: message`
 */
export function parseTypeScriptDiagnostics(
  output: string,
  stripPrefix: string,
): TypeScriptDiagnostic[] {
  const diagnostics: TypeScriptDiagnostic[] = [];
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
