/**
 * Whether the user trusts a repository: the one answer to "may Loxel run this repository's code?",
 * shared by every worktree of the repository. Untrusted is the default, and any doubt (a store or
 * folder that cannot be read) counts as untrusted.
 *
 * Trust permits running repository code and nothing else. It never permits downloading or
 * installing anything, which Loxel does not do automatically in any repository.
 */
import { lstatSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

import { z } from "zod";

import type { RepoTrustStatus } from "@/api/repo-trust-model";

import { readConfigFile } from "./config-file-read";
import { logger } from "./logger";
import { deleteStore, getStore, onStoreChange, putStore } from "./store-db";

const log = logger.child("server");

const KEY_PREFIX = "repo-trust:";

const TrustRecordSchema = z.object({ fingerprint: z.string() });

function realPathOrResolved(target: string): string {
  try {
    return realpathSync(target);
  } catch {
    return path.resolve(target);
  }
}

/**
 * The repository a linked worktree's `.git` file belongs to: its common directory, the same path
 * the main checkout has, or null when the file does not prove that link: the repository's own
 * record of the worktree (`gitdir` in its admin directory) must point back at this file.
 */
function linkedWorktreeRepo(folder: string, dotGit: string): string | null {
  const gitdir = /^gitdir: (.+)$/m.exec(readConfigFile(dotGit) ?? "")?.[1]?.trim();
  if (!gitdir) return null;
  try {
    const adminDir = realpathSync(path.resolve(folder, gitdir));
    const worktreesDir = path.dirname(adminDir);
    if (path.basename(worktreesDir) !== "worktrees") return null;
    const backLink = readConfigFile(path.join(adminDir, "gitdir"))?.trim();
    if (!backLink) return null;
    if (realpathSync(path.resolve(adminDir, backLink)) !== realpathSync(dotGit)) return null;
    return path.dirname(worktreesDir);
  } catch {
    return null;
  }
}

/** What trust is stored under, and the directory on disk that stands for it. */
interface RepoIdentity {
  id: string;
  dir: string;
}

/**
 * What trust is stored under for a worktree: the repository's git common directory, so all its
 * worktrees share one answer, or the worktree's own folder when it has none (a folder outside any
 * repository, a submodule). The two kinds have separate ids, so a repository claiming a folder as
 * its common directory cannot take that folder's answer. Remote URLs and commits identify nothing
 * here, since a fork has the same ones and the repository's config can claim any.
 *
 * Reads the filesystem instead of asking git, so that answering runs nothing in an untrusted
 * repository. A symlinked `.git` counts as no repository.
 */
function repoIdentity(wtPath: string): RepoIdentity {
  const folder = realPathOrResolved(wtPath);
  const dotGit = path.join(folder, ".git");
  let repoDir: string | null = null;
  try {
    const entry = lstatSync(dotGit);
    if (entry.isDirectory()) repoDir = dotGit;
    else if (entry.isFile()) repoDir = linkedWorktreeRepo(folder, dotGit);
  } catch {
    // No `.git` here: the folder stands for itself.
  }
  return repoDir ? { id: `git:${repoDir}`, dir: repoDir } : { id: `folder:${folder}`, dir: folder };
}

export function repoTrustId(wtPath: string): string {
  return repoIdentity(wtPath).id;
}

/**
 * Tells this directory from a later one at the same path, so deleting a trusted repository and
 * cloning another in its place does not pass the trust on.
 */
function fingerprintOf(dir: string): string {
  const { dev, ino, birthtimeMs } = statSync(dir);
  return `${dev}:${ino}:${birthtimeMs}`;
}

function isTrustedIdentity({ id, dir }: RepoIdentity): boolean {
  try {
    const raw = getStore(`${KEY_PREFIX}${id}`);
    if (!raw) return false;
    const record = TrustRecordSchema.safeParse(JSON.parse(raw));
    return record.success && record.data.fingerprint === fingerprintOf(dir);
  } catch (err) {
    log.warn("Treating a repository as untrusted: its trust could not be read", { id, error: err });
    return false;
  }
}

/** Whether Loxel may run code from the repository `wtPath` belongs to. */
export function isRepoTrusted(wtPath: string): boolean {
  return isTrustedIdentity(repoIdentity(wtPath));
}

/** What was reported as restricted per untrusted repository, since Loxel started. */
const restrictionsByRepo = new Map<string, Set<string>>();
const restrictionListeners = new Set<() => void>();

/** Trust or stop trusting the repository `wtPath` belongs to. Only the user's choice calls this. */
export function setRepoTrusted(wtPath: string, trusted: boolean): void {
  const identity = repoIdentity(wtPath);
  const key = `${KEY_PREFIX}${identity.id}`;
  if (trusted) {
    restrictionsByRepo.delete(identity.id);
    putStore(key, JSON.stringify({ fingerprint: fingerprintOf(identity.dir) }));
  } else {
    deleteStore(key);
  }
}

/**
 * Call `listener` when any repository's trust changes. It says nothing about which one: a consumer
 * asks {@link isRepoTrusted} again for each worktree it runs something in.
 */
export function onRepoTrustChange(listener: () => void): () => void {
  return onStoreChange((key) => {
    if (isRepoTrustStoreKey(key)) listener();
  });
}

/** Trust rows are written here and nowhere else, so the generic store route refuses them. */
export function isRepoTrustStoreKey(key: string): boolean {
  return key.startsWith(KEY_PREFIX);
}

/**
 * Record that something is running restricted in an untrusted repository, as one sentence for the
 * user, such as "Build scripts don't run". This is what makes Loxel show the choice: a repository
 * nothing asked about stays quiet.
 */
export function reportRepoRestriction(wtPath: string, restriction: string): void {
  const identity = repoIdentity(wtPath);
  if (isTrustedIdentity(identity)) return;
  const restrictions = restrictionsByRepo.get(identity.id) ?? new Set();
  if (restrictions.has(restriction)) return;
  restrictionsByRepo.set(identity.id, restrictions.add(restriction));
  for (const listener of restrictionListeners) listener();
}

/** Call `listener` when {@link getRepoTrustStatus} may answer differently for some worktree. */
export function onRepoTrustStatusChange(listener: () => void): () => void {
  restrictionListeners.add(listener);
  const unsubscribeTrust = onRepoTrustChange(listener);
  return () => {
    restrictionListeners.delete(listener);
    unsubscribeTrust();
  };
}

export function getRepoTrustStatus(wtPath: string): RepoTrustStatus {
  const identity = repoIdentity(wtPath);
  const trusted = isTrustedIdentity(identity);
  const { base } = path.parse(identity.dir);
  return {
    // The folder a person recognizes: a main checkout's rather than its `.git`.
    repository: base === ".git" || base === ".bare" ? path.dirname(identity.dir) : identity.dir,
    trusted,
    restrictions: trusted ? [] : [...(restrictionsByRepo.get(identity.id) ?? [])],
  };
}
