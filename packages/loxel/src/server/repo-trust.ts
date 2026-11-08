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

import type { RepoTrustDecision, RepoTrustEntry, RepoTrustStatus } from "@/api/repo-trust-model";

import { readConfigFile } from "./config-file-read";
import { logger } from "./logger";
import { deleteStore, getStore, listStoreKeys, onStoreChange, putStore } from "./store-db";

const log = logger.child("server");

const KEY_PREFIX = "repo-trust:";
/**
 * The user declined to trust the repository. A separate prefix rather than a field of the trust
 * row, so an older Loxel reading this row cannot take it for trust.
 */
const DECLINED_KEY_PREFIX = "repo-trust-declined:";

/** A trust or declined row: the fingerprint of the directory the answer was given for. */
const DecisionRecordSchema = z.object({ fingerprint: z.string() });

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

/** Whether a stored row exists and was written for this directory, rather than an earlier one. */
type RecordMatch = "none" | "matches" | "stale";

function matchRecord(key: string, dir: string): RecordMatch {
  const raw = getStore(key);
  if (!raw) return "none";
  try {
    const record = DecisionRecordSchema.safeParse(JSON.parse(raw));
    return record.success && record.data.fingerprint === fingerprintOf(dir) ? "matches" : "stale";
  } catch {
    // Unreadable, or the directory is gone.
    return "stale";
  }
}

function isTrustedIdentity({ id, dir }: RepoIdentity): boolean {
  try {
    return matchRecord(`${KEY_PREFIX}${id}`, dir) === "matches";
  } catch (err) {
    log.warn("Treating a repository as untrusted: its trust could not be read", { id, error: err });
    return false;
  }
}

/** The answer that applies to the identity's directory as it is now. */
function decisionOf(identity: RepoIdentity): RepoTrustDecision {
  if (isTrustedIdentity(identity)) return "trusted";
  try {
    const declined = matchRecord(`${DECLINED_KEY_PREFIX}${identity.id}`, identity.dir);
    return declined === "matches" ? "declined" : "undecided";
  } catch (err) {
    log.warn("Could not read whether a repository was declined", { id: identity.id, error: err });
    return "undecided";
  }
}

/** Whether Loxel may run code from the repository `wtPath` belongs to. */
export function isRepoTrusted(wtPath: string): boolean {
  return isTrustedIdentity(repoIdentity(wtPath));
}

/** What was reported as restricted per untrusted repository, since Loxel started. */
const restrictionsByRepo = new Map<string, Set<string>>();
const restrictionListeners = new Set<() => void>();

/**
 * Record the user's answer for the repository `wtPath` belongs to. Only the user's choice calls
 * this: their answer to the trust question, or creating a project from scratch, whose repository
 * starts trusted. Each answer replaces the other.
 */
export function setRepoTrustDecision(wtPath: string, decision: RepoTrustDecision): void {
  const identity = repoIdentity(wtPath);
  if (decision === "undecided") {
    forgetRepoTrust(identity.id);
    return;
  }
  const record = JSON.stringify({ fingerprint: fingerprintOf(identity.dir) });
  if (decision === "trusted") {
    restrictionsByRepo.delete(identity.id);
    deleteStored(`${DECLINED_KEY_PREFIX}${identity.id}`);
    putStore(`${KEY_PREFIX}${identity.id}`, record);
  } else {
    deleteStored(`${KEY_PREFIX}${identity.id}`);
    putStore(`${DECLINED_KEY_PREFIX}${identity.id}`, record);
  }
}

/** Delete a row only when there is one: every delete tells the store's listeners, which restart. */
function deleteStored(key: string): void {
  if (getStore(key) !== null) deleteStore(key);
}

/** Trust the repository `wtPath` belongs to, or clear its answer so it is asked again. */
export function setRepoTrusted(wtPath: string, trusted: boolean): void {
  setRepoTrustDecision(wtPath, trusted ? "trusted" : "undecided");
}

/**
 * Clear the stored answer for the repository `id` names, so it is asked again. Takes an id rather
 * than a worktree, since a repository no project uses has none; clearing can only take trust away.
 */
export function forgetRepoTrust(id: string): void {
  deleteStored(`${KEY_PREFIX}${id}`);
  deleteStored(`${DECLINED_KEY_PREFIX}${id}`);
}

/**
 * Call `listener` when any repository's trust changes. It says nothing about which one: a consumer
 * asks {@link isRepoTrusted} again for each worktree it runs something in.
 */
export function onRepoTrustChange(listener: () => void): () => void {
  return onStoreChange((key) => {
    // Declining changes nothing that runs: it only quiets the question.
    if (key.startsWith(KEY_PREFIX)) listener();
  });
}

/**
 * Trust and declined rows are written here and nowhere else, so the generic store route refuses
 * them: a repository cannot trust itself, nor silence the question.
 */
export function isRepoTrustStoreKey(key: string): boolean {
  return key.startsWith(KEY_PREFIX) || key.startsWith(DECLINED_KEY_PREFIX);
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
  const unsubscribeStore = onStoreChange((key) => {
    if (isRepoTrustStoreKey(key)) listener();
  });
  return () => {
    restrictionListeners.delete(listener);
    unsubscribeStore();
  };
}

/** The folder a person recognizes: a main checkout's rather than its `.git`. */
function displayFolder(dir: string): string {
  const { base } = path.parse(dir);
  return base === ".git" || base === ".bare" ? path.dirname(dir) : dir;
}

function restrictionsOf(id: string, decision: RepoTrustDecision): string[] {
  return decision === "trusted" ? [] : [...(restrictionsByRepo.get(id) ?? [])];
}

export function getRepoTrustStatus(wtPath: string): RepoTrustStatus {
  const identity = repoIdentity(wtPath);
  const decision = decisionOf(identity);
  return {
    repository: displayFolder(identity.dir),
    decision,
    restrictions: restrictionsOf(identity.id, decision),
  };
}

/** The directory an id stands for: the inverse of {@link repoIdentity}'s id. */
function identityOfId(id: string): RepoIdentity {
  return { id, dir: id.slice(id.indexOf(":") + 1) };
}

/** The stored answer for an identity, and whether it still applies to the directory there. */
function storedDecision(identity: RepoIdentity): Pick<RepoTrustEntry, "decision" | "stale"> {
  for (const [prefix, decision] of [
    [KEY_PREFIX, "trusted"],
    [DECLINED_KEY_PREFIX, "declined"],
  ] as const) {
    const match = matchRecord(`${prefix}${identity.id}`, identity.dir);
    if (match !== "none") return { decision, stale: match === "stale" };
  }
  return { decision: "undecided", stale: false };
}

/**
 * Every repository the user may want to answer for: the ones `worktreePaths` (every project's
 * worktrees) belong to, each with the first of its worktrees to answer through, and every stored
 * answer, including those for folders no project uses any more. Sorted by folder.
 */
export function listRepoTrust(worktreePaths: Iterable<string>): RepoTrustEntry[] {
  const worktreeOf = new Map<string, string>();
  const identities = new Map<string, RepoIdentity>();
  for (const wtPath of worktreePaths) {
    const identity = repoIdentity(wtPath);
    if (identities.has(identity.id)) continue;
    identities.set(identity.id, identity);
    worktreeOf.set(identity.id, wtPath);
  }
  for (const key of listStoreKeys()) {
    const prefix = [KEY_PREFIX, DECLINED_KEY_PREFIX].find((candidate) => key.startsWith(candidate));
    if (prefix === undefined) continue;
    const id = key.slice(prefix.length);
    if (!identities.has(id)) identities.set(id, identityOfId(id));
  }
  return [...identities.values()]
    .map((identity): RepoTrustEntry => {
      const stored = storedDecision(identity);
      const applied = stored.stale ? "undecided" : stored.decision;
      return {
        id: identity.id,
        repository: displayFolder(identity.dir),
        worktreePath: worktreeOf.get(identity.id) ?? null,
        ...stored,
        restrictions: restrictionsOf(identity.id, applied),
      };
    })
    .toSorted((a, b) => a.repository.localeCompare(b.repository));
}
