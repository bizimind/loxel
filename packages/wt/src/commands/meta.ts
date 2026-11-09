import { createResult } from "@bizimind/cli-common";

import {
  canonicalWorktreesDir,
  findWorktree,
  listWorktrees,
  metaKeyError,
  normalizeMetaKey,
  resolveRepoRoot,
  worktreeContaining,
  type WorktreeMeta,
} from "../git/index.ts";
import {
  getWorktreeMeta,
  parseMetaAssignments,
  type MetaParams,
  setWorktreeMeta,
  unsetWorktreeMeta,
  type WorktreeMetaResult,
} from "../lib/index.ts";
import { isTTY } from "../prompt.ts";
import { runCommand } from "./aborted.ts";
import { resolveWorktreeName } from "./select.ts";

interface MetaOptions {
  json?: boolean;
}

/** `wt meta get <name> <key>`: one key's value, null when it is not set. */
export interface MetaValueResult {
  name: string;
  path: string;
  key: string;
  value: string | null;
}

/** What sets each subcommand's target resolution apart. */
interface Subcommand {
  /** Phrase for the picker: "Select a worktree to <action>:" */
  action: string;
  usage: string;
  /**
   * Whether the first argument names the worktree, given whether a worktree
   * has that name. An argument that cannot be a key always does, so a
   * mistyped name fails as an unknown worktree rather than an invalid key.
   */
  firstIsName(arg: string, isWorktree: boolean, args: string[]): boolean;
}

const GET: Subcommand = {
  action: "read metadata of",
  usage: "wt meta get [name] [key]",
  firstIsName: (arg, isWorktree, args) =>
    args.length === 2 || isWorktree || metaKeyError(arg) !== null,
};

const SET: Subcommand = {
  action: "set metadata on",
  usage: "wt meta set [name] <key=value...>",
  // A key=value pair is never a worktree name.
  firstIsName: (arg) => !arg.includes("="),
};

const UNSET: Subcommand = {
  action: "unset metadata on",
  usage: "wt meta unset [name] <key...>",
  firstIsName: (arg, isWorktree) => isWorktree || metaKeyError(arg) !== null,
};

/** `wt meta get [name] [key]`: every key, or one key's value. */
export async function metaGetCommand(args: string[], options: MetaOptions): Promise<void> {
  await runCommand<WorktreeMetaResult | MetaValueResult>(options, async () => {
    if (args.length > 2) throw new Error(`Usage: ${GET.usage}`);
    const repoPath = process.cwd();
    const { target, rest } = await resolveTarget(GET, args, repoPath);
    const result = await getWorktreeMeta(target);

    const [key] = rest;
    if (key === undefined) return createResult(result, (data) => formatMeta(data.meta));

    const normalized = normalizeMetaKey(key);
    const value = result.meta[normalized] ?? null;
    return createResult<MetaValueResult>(
      { name: result.name, path: result.path, key: normalized, value },
      (data) => data.value ?? "",
    );
  });
}

/** `wt meta set [name] key=value...` */
export async function metaSetCommand(args: string[], options: MetaOptions): Promise<void> {
  await runCommand<WorktreeMetaResult>(options, async () => {
    const repoPath = process.cwd();
    const { target, rest } = await resolveTarget(SET, args, repoPath);
    if (rest.length === 0) throw new Error(`Usage: ${SET.usage}`);

    const result = await setWorktreeMeta({ ...target, values: parseMetaAssignments(rest) });
    return createResult(result, formatMetaResult);
  });
}

/** `wt meta unset [name] key...` */
export async function metaUnsetCommand(args: string[], options: MetaOptions): Promise<void> {
  await runCommand<WorktreeMetaResult>(options, async () => {
    const repoPath = process.cwd();
    const { target, rest } = await resolveTarget(UNSET, args, repoPath);
    if (rest.length === 0) throw new Error(`Usage: ${UNSET.usage}`);

    const result = await unsetWorktreeMeta({ ...target, keys: rest });
    return createResult(result, formatMetaResult);
  });
}

/** `key=value` lines, sorted by key. */
export function formatMeta(meta: WorktreeMeta): string {
  const entries = Object.entries(meta).sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) return "No metadata.";
  return entries.map(([key, value]) => `${key}=${value}`).join("\n");
}

function formatMetaResult(result: WorktreeMetaResult): string {
  return `Metadata of '${result.name}':\n${formatMeta(result.meta)}`;
}

/**
 * Split the arguments into the worktree to act on and the rest: the first
 * argument when `firstIsName` says so, else the worktree holding the cwd (the
 * main worktree of a non-bare repo included), else one picked like `wt view`.
 */
async function resolveTarget(
  subcommand: Subcommand,
  args: string[],
  repoPath: string,
): Promise<{ target: MetaParams; rest: string[] }> {
  const root = await resolveRepoRoot(repoPath);
  const dir = await canonicalWorktreesDir(root);
  const worktrees = await listWorktrees(root);

  const [first, ...rest] = args;
  if (first !== undefined) {
    const isWorktree = findWorktree(worktrees, dir, first) !== undefined;
    if (subcommand.firstIsName(first, isWorktree, args)) {
      return { target: { name: first, repoPath }, rest };
    }
  }

  // By path: the name of an unmanaged worktree (the main one, or one under `.claude/`) is only its
  // directory name, which may also name another worktree.
  const current = worktreeContaining(worktrees, process.cwd());
  if (current) return { target: { path: current.path, repoPath }, rest: args };

  // A lone key outside every worktree is most likely a mistyped name.
  if (first !== undefined && metaKeyError(first) === null && !isTTY()) {
    throw new Error(
      `No worktree is named '${first}', and the current directory is in none.\n\nUsage: ${subcommand.usage}`,
    );
  }
  const name = await resolveWorktreeName(undefined, subcommand.action, repoPath, subcommand.usage);
  return { target: { name, repoPath }, rest: args };
}
