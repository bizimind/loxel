import { join } from "node:path";

import { loadConfig, getWorktreesDir, type LoadedConfig } from "../config/loader.ts";
import { processFiles, resolveCopySource } from "../hooks/copy.ts";
import { runHookScript } from "../hooks/run.ts";
import { computeAllEnvVars } from "../worktree/env.ts";
import {
  addWorktree,
  branchExists,
  deleteBranch,
  fetchBranch,
  findWorktreeByName,
  isBareRepo,
  listWorktrees,
  remoteBranchExists,
} from "../worktree/git.ts";
import { StateManager } from "../worktree/state.ts";
import { silentProgress, type ProgressHandler } from "./progress.ts";

// ── Types ──────────────────────────────────────────────────────────────

export type BranchConflict =
  | { kind: "used-by-worktree"; worktreePath: string }
  | { kind: "exists-unused"; branchName: string };

export interface AddPlan {
  /** The resolved worktree name */
  name: string;
  /** Full path where the worktree will be created */
  worktreePath: string;
  /** Branch conflict that needs user resolution, or null if no conflict */
  branchConflict: BranchConflict | null;
}

export interface AddParams {
  name: string;
  branch?: string;
  /** Required when planAdd returned a branchConflict of kind "exists-unused" */
  branchResolution?: "use-existing" | "delete-and-create";
  /** Whether to open in editor (default: config.auto_open) */
  open?: boolean;
  /** Bare repo root path — required, never derived from cwd */
  repoPath: string;
  /** Pre-loaded config to avoid redundant wt.yaml reads. */
  loadedConfig?: LoadedConfig;
  /** Base environment for hook execution (default: process.env). Use to provide resolved shell PATH when calling from a non-shell context (e.g., GUI app). */
  hookEnv?: Record<string, string | undefined>;
}

export interface AddResult {
  name: string;
  path: string;
  branch: string;
  portOffset: number;
  env: Record<string, string>;
}

// ── Plan ───────────────────────────────────────────────────────────────

/**
 * Inspect state and determine what decisions are needed before adding a worktree.
 * No mutations — safe to call speculatively.
 *
 * @param params.loadedConfig - Pre-loaded config to avoid redundant wt.yaml reads.
 */
export async function planAdd(params: {
  name: string;
  repoPath: string;
  loadedConfig?: LoadedConfig;
}): Promise<AddPlan> {
  const { name, repoPath } = params;
  const { config, rootDir } = params.loadedConfig ?? (await loadConfig(repoPath, { repoPath }));
  const worktreesDir = getWorktreesDir({ config, rootDir, configPath: "" });
  const worktreePath = join(worktreesDir, name);

  if (!(await isBareRepo(rootDir))) {
    throw new Error("wt currently only supports bare repositories.");
  }

  const existingWorktrees = await listWorktrees(rootDir);
  if (findWorktreeByName(existingWorktrees, name)) {
    throw new Error(`Worktree '${name}' already exists. Use 'wt open ${name}' to open it.`);
  }

  // Check for branch conflicts when auto_branch is enabled
  let branchConflict: BranchConflict | null = null;
  if (config.auto_branch && (await branchExists(rootDir, name))) {
    const worktreeUsingBranch = existingWorktrees.find((wt) => wt.branch === name && !wt.bare);
    if (worktreeUsingBranch) {
      branchConflict = { kind: "used-by-worktree", worktreePath: worktreeUsingBranch.path };
    } else {
      branchConflict = { kind: "exists-unused", branchName: name };
    }
  }

  return { name, worktreePath, branchConflict };
}

// ── Execute ────────────────────────────────────────────────────────────

/**
 * Create a worktree with all resolved decisions.
 * Throws if a branch conflict exists but no branchResolution is provided.
 */
export async function executeAdd(
  params: AddParams,
  progress: ProgressHandler = silentProgress,
): Promise<AddResult> {
  const { name, repoPath } = params;
  const { config, rootDir } = params.loadedConfig ?? (await loadConfig(repoPath, { repoPath }));
  const worktreesDir = getWorktreesDir({ config, rootDir, configPath: "" });
  const worktreePath = join(worktreesDir, name);

  const branchInfo = await resolveBranchStrategy(rootDir, name, params, config);

  progress.log(`Creating worktree '${name}'...`);
  await createWorktreeFromBranch(progress, rootDir, worktreePath, branchInfo, config);
  progress.log(`  Created at: ${worktreePath}`);

  const state = new StateManager(rootDir);
  if (await state.hasWorktree(name)) {
    progress.warn(`  Warning: Cleaning up stale state entry for '${name}'`);
    await state.freeIndex(name);
  }
  const index = await state.allocateIndex(name);
  const portOffset = index * config.port_offseting.offset;
  progress.log(`  Port offset index: ${index} (WT_PORT_OFFSET=${portOffset})`);

  const env = computeAllEnvVars(name, worktreePath, rootDir, index, config);
  await runAddHooks(progress, config, rootDir, worktreePath, env, params.hookEnv);
  handleEditorOpen(progress, params, config, worktreePath);

  return { name, path: worktreePath, branch: branchInfo.branchName ?? "HEAD", portOffset, env };
}

// ── Internal helpers ───────────────────────────────────────────────────

interface BranchInfo {
  branchName?: string;
  useExisting: boolean;
}

type ConfigType = Awaited<ReturnType<typeof loadConfig>>["config"];

async function resolveBranchStrategy(
  rootDir: string,
  name: string,
  params: AddParams,
  config: ConfigType,
): Promise<BranchInfo> {
  if (params.branch) {
    if (!(await branchExists(rootDir, params.branch))) {
      throw new Error(`Branch '${params.branch}' does not exist.`);
    }
    return { branchName: params.branch, useExisting: true };
  }

  if (config.auto_branch) {
    if (await branchExists(rootDir, name)) {
      // Branch exists — require a resolution
      const existingWorktrees = await listWorktrees(rootDir);
      const worktreeUsingBranch = existingWorktrees.find((wt) => wt.branch === name && !wt.bare);
      if (worktreeUsingBranch) {
        throw new Error(
          `A worktree already exists for branch '${name}' at: ${worktreeUsingBranch.path}`,
        );
      }

      if (!params.branchResolution) {
        throw new Error(
          `Branch '${name}' already exists. Provide branchResolution: "use-existing" or "delete-and-create".`,
        );
      }

      if (params.branchResolution === "use-existing") {
        return { branchName: name, useExisting: true };
      }

      // delete-and-create
      await deleteBranch(rootDir, name, true);
      return { branchName: name, useExisting: false };
    }

    return { branchName: name, useExisting: false };
  }

  return { useExisting: false };
}

async function createWorktreeFromBranch(
  progress: ProgressHandler,
  rootDir: string,
  worktreePath: string,
  branchInfo: BranchInfo,
  config: ConfigType,
): Promise<void> {
  if (branchInfo.useExisting && branchInfo.branchName) {
    await addWorktree(rootDir, worktreePath, { branch: branchInfo.branchName });
  } else if (branchInfo.branchName) {
    const fetched = await fetchBranch(rootDir, config.remote, config.base_branch);
    if (!fetched) {
      progress.warn(`  Warning: Could not fetch ${config.base_branch} from ${config.remote}`);
    }

    const baseRef = await resolveBaseRef(rootDir, config);
    progress.log(`  Based on: ${baseRef}`);
    await addWorktree(rootDir, worktreePath, {
      newBranch: branchInfo.branchName,
      baseBranch: baseRef,
    });
  } else {
    await addWorktree(rootDir, worktreePath, {});
  }
}

async function resolveBaseRef(rootDir: string, config: ConfigType): Promise<string> {
  const { remote, base_branch } = config;
  const remoteRef = `${remote}/${base_branch}`;

  if (await remoteBranchExists(rootDir, remote, base_branch)) {
    return remoteRef;
  }
  if (await branchExists(rootDir, base_branch)) {
    return base_branch;
  }
  throw new Error(`Base branch '${base_branch}' not found locally or on remote '${remote}'.`);
}

async function runAddHooks(
  progress: ProgressHandler,
  config: ConfigType,
  rootDir: string,
  worktreePath: string,
  env: Record<string, string>,
  hookEnv?: Record<string, string | undefined>,
): Promise<void> {
  if (config.hooks?.add?.files && config.hooks.add.files.length > 0) {
    progress.log("\nProcessing files...");
    const copySource = await resolveCopySource(config.copy_source, rootDir);
    progress.log(`  Source: ${copySource}`);
    await processFiles(config.hooks.add.files, copySource, worktreePath, { env });
  }

  if (config.hooks?.add?.run) {
    progress.log("\nRunning add hook...");
    const result = await runHookScript(config.hooks.add.run, worktreePath, env, hookEnv);
    if (result.output) {
      progress.log(result.output);
    }
  }
}

function handleEditorOpen(
  progress: ProgressHandler,
  params: AddParams,
  config: ConfigType,
  worktreePath: string,
): void {
  const shouldOpen = params.open ?? config.auto_open;
  if (shouldOpen && config.editor) {
    progress.log(`\nOpening in ${config.editor}...`);
    Bun.spawn([config.editor, worktreePath], { stdout: "ignore", stderr: "ignore" });
  } else if (shouldOpen && !config.editor) {
    progress.log('\nNote: Set "editor" in wt.yaml to auto-open worktrees.');
  }
}
