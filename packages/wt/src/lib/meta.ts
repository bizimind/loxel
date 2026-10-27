/**
 * Per-worktree metadata: free-form `key=value` pairs that wt stores for other
 * tools to interpret (see `../git/worktree-meta.ts` for where they live).
 *
 * Keys starting with `wt-` are wt's own: `wt-id` is a UUID given to every
 * worktree wt creates while metadata is on, and lazily to an older one the
 * first time its metadata is written. Tools reference worktrees by that id,
 * never by name, so a rename cannot break a reference. Callers cannot set or
 * unset `wt-*` keys.
 *
 * Metadata needs per-worktree config on (`wt init --worktree-metadata on`).
 * While it is off, writes fail with a pointer to that command and reads
 * return no metadata.
 */
import { randomUUID } from "node:crypto";

import {
  addMetaValue,
  canonicalWorktreesDir,
  claimMeta,
  findWorktree,
  getWorktreeName,
  gitCommonDir,
  isReservedMetaKey,
  isWorktreeConfigEnabled,
  listWorktrees,
  normalizeMetaKey,
  readMeta,
  resetMeta,
  resolveRepoRoot,
  unsetMeta,
  worktreeConfigFiles,
  WORKTREE_ID_KEY,
  writeMeta,
  type Worktree,
  type WorktreeMeta,
} from "../git/index.ts";

/** The error every metadata write fails with while metadata is off. */
export const METADATA_OFF_MESSAGE =
  "Worktree metadata is off for this repository. Turn it on with: wt init --worktree-metadata on";

/** One worktree's metadata. */
export interface WorktreeMetaResult {
  name: string;
  path: string;
  /** Every key, `wt-id` included; empty while metadata is off */
  meta: WorktreeMeta;
}

/** The worktree to act on: by name (as `wt list` shows it), or by its exact path. */
export type MetaParams = {
  /** Any path inside the repository (bare or non-bare) */
  repoPath: string;
} & ({ name: string } | { path: string });

/**
 * Whether per-worktree metadata is on for the repository.
 *
 * @param repoPath - Any path inside the repository (bare or non-bare)
 */
export async function isWorktreeMetadataEnabled(repoPath: string): Promise<boolean> {
  return isWorktreeConfigEnabled(await gitCommonDir(repoPath));
}

/**
 * Validate a key a caller wants to write and return it lowercase, as git
 * stores it. Throws for an invalid key or a reserved `wt-*` one.
 */
export function writableMetaKey(key: string): string {
  const normalized = normalizeMetaKey(key);
  if (isReservedMetaKey(normalized)) {
    throw new Error(
      `Metadata key '${normalized}' is reserved: keys starting with 'wt-' belong to wt.`,
    );
  }
  return normalized;
}

/** `values` with every key checked by `writableMetaKey` and normalized. */
export function writableMeta(values: WorktreeMeta): WorktreeMeta {
  return Object.fromEntries(
    Object.entries(values).map(([key, value]) => [writableMetaKey(key), value]),
  );
}

/**
 * Parse `key=value` arguments (split at the first `=`; the value may be
 * empty) into normalized, writable keys. A repeated key keeps its last value.
 */
export function parseMetaAssignments(assignments: string[]): WorktreeMeta {
  const values: WorktreeMeta = {};
  for (const assignment of assignments) {
    const eq = assignment.indexOf("=");
    if (eq === -1) throw new Error(`Expected key=value, got '${assignment}'.`);
    values[writableMetaKey(assignment.slice(0, eq))] = assignment.slice(eq + 1);
  }
  return values;
}

/**
 * The metadata of each worktree, keyed by path; every record is empty while
 * metadata is off. A worktree whose config file git cannot parse gets an
 * empty record and a `warn`, so one broken file does not hide the others.
 *
 * @param worktrees - The full list `listWorktrees` returns: its first entry
 *   tells the main worktree apart from the linked ones.
 */
export async function readWorktreesMeta(
  root: string,
  worktrees: Worktree[],
  warn: (message: string) => void = () => {},
): Promise<Map<string, WorktreeMeta>> {
  const commonDir = await gitCommonDir(root);
  if (!(await isWorktreeConfigEnabled(commonDir))) {
    return new Map(worktrees.map((wt) => [wt.path, {}]));
  }
  const files = await worktreeConfigFiles(commonDir, worktrees);
  return new Map(
    await Promise.all(
      worktrees.map(async (wt) => {
        const file = files.get(wt.path);
        if (!file) return [wt.path, {}] as const;
        try {
          return [wt.path, await readMeta(commonDir, file)] as const;
        } catch (error) {
          warn(error instanceof Error ? error.message : String(error));
          return [wt.path, {}] as const;
        }
      }),
    ),
  );
}

/** One worktree's metadata; empty while metadata is off. */
export async function getWorktreeMeta(params: MetaParams): Promise<WorktreeMetaResult> {
  const target = await locateMetaTarget(params);
  return {
    name: target.name,
    path: target.path,
    meta: target.enabled ? await readMeta(target.commonDir, target.file) : {},
  };
}

/**
 * Set keys on a worktree, giving it a `wt-id` first if it has none. Keys are
 * validated as by `writableMetaKey`.
 */
export async function setWorktreeMeta(
  params: MetaParams & { values: WorktreeMeta },
): Promise<WorktreeMetaResult> {
  const values = writableMeta(params.values);
  const target = await locateWritableTarget(params);
  await assignIdIfMissing(target);
  await writeMeta(target.commonDir, target.file, values);
  return {
    name: target.name,
    path: target.path,
    meta: await readMeta(target.commonDir, target.file),
  };
}

/** Remove keys from a worktree (missing ones are fine), giving it a `wt-id` first if it has none. */
export async function unsetWorktreeMeta(
  params: MetaParams & { keys: string[] },
): Promise<WorktreeMetaResult> {
  const keys = params.keys.map(writableMetaKey);
  const target = await locateWritableTarget(params);
  await assignIdIfMissing(target);
  await unsetMeta(target.commonDir, target.file, keys);
  return {
    name: target.name,
    path: target.path,
    meta: await readMeta(target.commonDir, target.file),
  };
}

/**
 * A worktree's `wt-id`, assigning one if it has none yet. Use it to reference
 * a worktree created before metadata was turned on.
 */
export async function ensureWorktreeId(params: MetaParams): Promise<string> {
  return assignIdIfMissing(await locateWritableTarget(params));
}

/**
 * Write the metadata of a worktree wt just created: a fresh `wt-id` plus the
 * caller's (already validated) values. A no-op while metadata is off.
 *
 * `git worktree add` copied the config file of the worktree it ran in, so the
 * section starts over: nothing is inherited from that worktree.
 */
export async function initWorktreeMeta(
  root: string,
  worktreePath: string,
  values: WorktreeMeta,
): Promise<WorktreeMeta> {
  const commonDir = await gitCommonDir(root);
  if (!(await isWorktreeConfigEnabled(commonDir))) return {};

  const file = (await worktreeConfigFiles(commonDir, await listWorktrees(root))).get(worktreePath);
  if (!file) throw new Error(`Cannot find the config file of the worktree at ${worktreePath}`);
  await resetMeta(commonDir, file);
  await writeMeta(commonDir, file, { [WORKTREE_ID_KEY]: randomUUID(), ...values });
  return readMeta(commonDir, file);
}

/** A worktree resolved for metadata access. */
interface MetaTarget {
  name: string;
  path: string;
  commonDir: string;
  /** The worktree's own config file */
  file: string;
  /** Metadata is on */
  enabled: boolean;
}

/**
 * Resolve a worktree by exact path, or by name the way `wt view` does:
 * managed worktrees, plus the main worktree of a non-bare repo by its
 * directory name.
 */
async function locateMetaTarget(params: MetaParams): Promise<MetaTarget> {
  const root = await resolveRepoRoot(params.repoPath);
  const dir = await canonicalWorktreesDir(root);
  const worktrees = await listWorktrees(root);
  const worktree =
    "path" in params
      ? worktrees.find((wt) => !wt.bare && wt.path === params.path)
      : findWorktree(worktrees, dir, params.name);
  if (!worktree) {
    const name = "path" in params ? params.path : params.name;
    const available = worktrees.filter((wt) => !wt.bare).map((wt) => getWorktreeName(wt.path, dir));
    const list =
      available.length > 0 ? `\n\nAvailable worktrees:\n  ${available.join("\n  ")}` : "";
    throw new Error(`Worktree '${name}' not found.${list}`);
  }

  const commonDir = await gitCommonDir(root);
  const file = (await worktreeConfigFiles(commonDir, worktrees)).get(worktree.path);
  if (!file) throw new Error(`Cannot find the config file of the worktree at ${worktree.path}`);
  return {
    name: getWorktreeName(worktree.path, dir),
    path: worktree.path,
    commonDir,
    file,
    enabled: await isWorktreeConfigEnabled(commonDir),
  };
}

async function locateWritableTarget(params: MetaParams): Promise<MetaTarget> {
  const target = await locateMetaTarget(params);
  if (!target.enabled) throw new Error(METADATA_OFF_MESSAGE);
  return target;
}

/**
 * The worktree's `wt-id`, written first if it has none. Concurrent callers
 * agree on one id: each appends its candidate and reads back the first value,
 * which no later append can displace.
 */
async function assignIdIfMissing(target: MetaTarget): Promise<string> {
  await claimMeta(target.commonDir, target.file);
  const id = (await readMeta(target.commonDir, target.file))[WORKTREE_ID_KEY];
  if (id) return id;

  await addMetaValue(target.commonDir, target.file, WORKTREE_ID_KEY, randomUUID());
  const assigned = (await readMeta(target.commonDir, target.file))[WORKTREE_ID_KEY];
  if (!assigned) throw new Error(`Cannot assign a ${WORKTREE_ID_KEY} to ${target.path}`);
  // Collapse the candidates to the winner, so git's own `--get` (which reports the last value,
  // as a hook would use it) agrees. Every racer writes the same winner, so this is idempotent.
  await writeMeta(target.commonDir, target.file, { [WORKTREE_ID_KEY]: assigned });
  return assigned;
}
