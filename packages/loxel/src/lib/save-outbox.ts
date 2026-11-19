/**
 * The save outbox: every editor save is kept here, in memory and in IndexedDB, until the server
 * confirms it. A save that fails because the server cannot be reached (it is restarting, or not
 * subscribed to the worktree yet) stays queued and is retried once its worktree is served again and
 * on a backoff timer, after reading the file and merging with whatever is on disk by then. It
 * survives its tab closing and the window reloading or quitting, and is settled once its worktree
 * is gone. See docs/EDITOR.md, "Save outbox".
 */

import * as api from "@/api/client";
import { whenLocalServerKnown } from "@/api/local-server";
import {
  ApiError,
  hasConnection,
  isDiskChangedError,
  isFileMissingError,
} from "@/api/server-connection";
import {
  type ServerId,
  type WorktreeRef,
  type WorktreeRefKey,
  formatWorktreeRef,
  sameWorktreeRef,
  worktreeRef,
} from "@/api/worktree-ref";
import { showToast } from "@/components/ui/toast";
import { getDisplayFilename } from "@/lib/detached-path";
import { frontendLog } from "@/lib/frontend-logger";
import { onLoxelEvent } from "@/lib/loxel-events";
import { openFile } from "@/lib/open-path";
import { isWithin } from "@/lib/project-file-helpers";
import {
  type SaveOptions,
  holdWorktree,
  onWorktreeSavesDrained,
  postEditorContent,
  releaseWorktree,
} from "@/lib/save-editor-content";
import { threeWayMerge } from "@/lib/three-way-merge";
import {
  type EditorFileEntry,
  type EditorKey,
  diskBase,
  fileEditorKey,
  isFileTabKey,
  useEditorStateStore,
} from "@/store/editor-state";
import { projectOf, useProjectStore, whenProjectsLoaded } from "@/store/projects";
import { isListedWorktree, useWorktreeStore } from "@/store/worktrees";

const log = frontendLog.child("files");

/**
 * `sending`: a request for it is in flight. `queued`: it failed for a reason that can pass and
 * waits for a retry; `retrying` while a retry reads the file first. `review`: it needs the user,
 * because it conflicts with the file on disk (`disk` holds that version), the file is gone, or the
 * server refused it; it is not retried and is shown in the file's tab, which takes it over when
 * it next opens.
 */
export type OutboxStatus = "sending" | "queued" | "retrying" | "review";

export interface OutboxEntry {
  id: string;
  /** The editor that made the save (`EditorFileEntry.instanceId`); it has at most one entry. */
  instanceId: string;
  /** The window (page load) that owns the entry. Entries of a window that is gone are recovered. */
  ownerId: string;
  editorKey: EditorKey;
  /**
   * The server holding the file, the one the save is sent to. Paths alone collide once two
   * servers hold the same one, and IndexedDB is per origin, not per server.
   */
  server: ServerId;
  /** On `server`. */
  filePath: string;
  /** On `server`. */
  worktreePath: string | null;
  /** The disk content the edits were made on: the merge base. null if the editor never had it. */
  base: string | null;
  content: string;
  options?: SaveOptions;
  /** Orders the saves of one window: a late response of an older save must not undo a newer one. */
  seq: number;
  status: OutboxStatus;
  /** For `review`: the disk content the save conflicts with, null when there is none to show. */
  disk: string | null;
  /**
   * Why the server refused the save (its error message), shown on its editor. Set in `review`,
   * and kept while a newer save of the editor is being sent; absent in entries of older versions.
   */
  refusal?: string;
  /**
   * Set on an entry taken over at startup whose edits may not have been made on `server`'s file:
   * one stored before entries named their server (`earlier-version`), or one of a server no open
   * window is connected to (`other-server`), such as the window's own server before its ID
   * changed. It is kept in `review` and shown as a conflict with the file on disk, never written
   * without the user, until the user acts on it (see `initSaveOutbox`).
   */
  takenFrom?: TakenFrom;
}

export type TakenFrom = "earlier-version" | "other-server";

/**
 * An entry as stored. One stored before entries named their server has none: it was made when one
 * origin served one server, but which one can no longer be told (see `takenFrom`). Its `server` is
 * whatever was stored: one the ID grammar refuses is of no server the window knows.
 */
export type StoredOutboxEntry = Omit<OutboxEntry, "server"> & { server?: string };

/** Where entries persist between runs. A write resolves once stored, and rejects if it was not. */
export interface OutboxStorage {
  load: () => Promise<StoredOutboxEntry[]>;
  put: (entry: OutboxEntry) => Promise<void>;
  remove: (id: string) => Promise<void>;
}

/** Retry delays after consecutive failed rounds; the last one repeats. */
const RETRY_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000];
const LOCK_PREFIX = "loxel-save-outbox:";
/** Each window also holds a shared lock named after its server, for as long as it is open. */
const SERVER_LOCK_PREFIX = "loxel-save-outbox-server:";
/** Held by a window until it holds its server's lock: its server may be any, so it is every one's. */
const STARTING_LOCK_PREFIX = "loxel-save-outbox-starting:";
/** Passes in a row a retry round makes for saves whose file changed between read and write. */
const MAX_CHANGED_PASSES = 3;

/** This window (page load); a new one in tests, as after a reload. */
let ownerId = crypto.randomUUID();
const entries = new Map<string, OutboxEntry>();
let storage: OutboxStorage | null = null;
/** A store failed, and none succeeded since: the user has been told. */
let storageFailing = false;
/** The newest confirmed save of each editor instance, by `seq`. */
const confirmedSeq = new Map<string, number>();
let nextSeq = 1;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let failedRounds = 0;
let currentRun: Promise<void> | null = null;
/** A retry was asked for while one ran: run another pass once it ends. */
let runAgain = false;
/** Entries recovered from an earlier run whose outcome is not reported yet. */
const recovered = new Set<string>();
const recoveredSaved: string[] = [];
/** The worktree each entry not yet saved holds subscribed (`holdWorktree`), by entry id. */
const heldWorktrees = new Map<string, WorktreeRef>();
/**
 * Worktrees gone from this window's lists (`loxel-worktree-gone`), until served again, and whether
 * the user discarded them: their saves can no longer be sent, so they are settled, not retried.
 */
const goneWorktrees = new Map<WorktreeRefKey, boolean>();

/** The worktree of `entry` on its server; null for a save of no worktree (Home's drafts). */
function entryWorktree(entry: OutboxEntry): WorktreeRef | null {
  return entry.worktreePath === null ? null : worktreeRef(entry.server, entry.worktreePath);
}

/** The key of `entry`'s worktree in {@link goneWorktrees}; null with none. */
function entryWorktreeKey(entry: OutboxEntry): WorktreeRefKey | null {
  const wt = entryWorktree(entry);
  return wt ? formatWorktreeRef(wt) : null;
}

/**
 * Why a failed request may succeed later: `unreachable`, the server could not be reached (or
 * answered that it is unavailable, or no longer accepts this window's session, which a reload
 * fixes, and the outbox keeps the save across it); `unavailable`, it does not serve this path
 * right now (a plain 404: the path is in no worktree it has resources for, because it restarted
 * or the window has not subscribed again yet). null for a real answer, such as ENOENT or a refused write.
 */
function retryReason(err: unknown): "unreachable" | "unavailable" | null {
  if (err instanceof TypeError) return "unreachable"; // fetch could not reach the server
  if (!(err instanceof ApiError)) return null;
  if (err.status === 404) return err.code === "ENOENT" ? null : "unavailable";
  return [401, 502, 503, 504].includes(err.status) ? "unreachable" : null;
}

/** Whether a failed save may succeed later: the server was unreachable or not ready for it. */
export function isRetriableSaveError(err: unknown): boolean {
  return retryReason(err) !== null;
}

// -- Entries --

/** Store `entry`; resolves once stored, or once a failure to store it has been reported. */
function persist(entry: OutboxEntry): Promise<void> {
  if (!storage || entries.get(entry.id) !== entry) return Promise.resolve();
  return storage.put(entry).then(storeSucceeded, storeFailed);
}

function storeSucceeded(): void {
  storageFailing = false;
}

/** The edits still go to the server; only surviving a reload or a crash before then is lost. */
function storeFailed(error: unknown): void {
  log.error("Failed to store the save outbox", { error });
  if (storageFailing) return;
  storageFailing = true;
  showToast(
    "Unsaved edits could not be stored: they are lost if Loxel closes before they are saved",
  );
}

function removeEntry(entry: OutboxEntry): void {
  if (entries.get(entry.id) !== entry) return;
  entries.delete(entry.id);
  recovered.delete(entry.id);
  // Only a stored entry tells that storing works again: a failing store may still delete.
  void storage?.remove(entry.id).catch(storeFailed);
  entriesChanged();
}

function entryOfInstance(instanceId: string): OutboxEntry | undefined {
  for (const entry of entries.values()) if (entry.instanceId === instanceId) return entry;
  return undefined;
}

/** The mounted editor that owns `entry`, if any. */
function ownerEditor(entry: OutboxEntry): EditorFileEntry | undefined {
  const editor = useEditorStateStore.getState().files.get(entry.editorKey);
  return editor?.instanceId === entry.instanceId ? editor : undefined;
}

/**
 * On every editor-state change: an editor back to clean shows what is on disk, so its entry has
 * nothing left to save (the user accepted the disk version of a conflict). A conflict's disk
 * version is kept current, for the banner the save is shown with after a reload.
 */
function onEditorsChanged(): void {
  for (const entry of entries.values()) {
    if (entry.status === "retrying" || entry.status === "sending") continue;
    const editor = ownerEditor(entry);
    if (editor?.state === "clean") {
      removeEntry(entry);
    } else if (
      entry.status === "review" &&
      editor?.state === "diverged" &&
      editor.diskContent !== entry.disk
    ) {
      entry.disk = editor.diskContent;
      void persist(entry);
    }
  }
  entriesChanged();
}

useEditorStateStore.subscribe(onEditorsChanged);

// A worktree is served again (subscribed, after a reconnect or a server restart): retry its saves
// at once. The timer is left for the rest, such as a server that answered with an error.
onLoxelEvent("loxel-worktree-files-resynced", ({ wt }) => {
  const key = formatWorktreeRef(wt);
  goneWorktrees.delete(key); // created again at the same path
  const waiting = [...entries.values()].some(
    (entry) => entry.status === "queued" && entryWorktreeKey(entry) === key,
  );
  if (!waiting) return;
  failedRounds = 0;
  scheduleRetry(0);
});

onLoxelEvent("loxel-worktree-gone", ({ wt, discarded }) => {
  const key = formatWorktreeRef(wt);
  // A removal in Loxel is also seen in the list that follows it: that must not undo the discard.
  goneWorktrees.set(key, discarded || goneWorktrees.get(key) === true);
  settleGoneSaves();
});

function isGone(entry: OutboxEntry): boolean {
  const key = entryWorktreeKey(entry);
  return key !== null && goneWorktrees.has(key);
}

/**
 * Settle the saves of gone worktrees, which can no longer be sent. The user removed the worktree in
 * Loxel (`discarded`): they are dropped, and the user is told. Gone any other way (removed outside
 * Loxel, moved, its project only removed from Loxel), the files may still be somewhere: a waiting
 * save is kept for review, without being retried or holding the worktree, and shown when its file's
 * tab next opens. A save in flight is settled when it fails.
 */
function settleGoneSaves(): void {
  const dropped: string[] = [];
  for (const entry of [...entries.values()]) {
    const key = entryWorktreeKey(entry);
    if (key === null) continue;
    const discarded = goneWorktrees.get(key);
    if (discarded === undefined) continue;
    if (discarded && (entry.status === "queued" || entry.status === "review")) {
      dropped.push(getDisplayFilename(entry.filePath));
      removeEntry(entry);
    } else if (entry.status === "queued") {
      entry.status = "review";
      entry.disk = null;
      recovered.delete(entry.id);
      void persist(entry);
    }
  }
  entriesChanged();
  if (dropped.length === 0) return;
  log.info("Dropped unsaved edits of a removed worktree", { count: dropped.length });
  showToast(`Unsaved edits to ${dropped.join(", ")} were discarded with their worktree`, "info");
}

/** Bring what follows from the entries in step with them: editors' flags, worktrees held. */
function entriesChanged(): void {
  syncEditorFlags();
  syncHeldWorktrees();
}

/** Keep each editor's `queued` and `saveRefused` flags in step with its entry. */
function syncEditorFlags(): void {
  const store = useEditorStateStore.getState();
  for (const [key, editor] of store.files) {
    const entry = entryOfInstance(editor.instanceId);
    const queued = isWaiting(entry);
    if (editor.queued !== queued) store.setQueued(key, queued);
    const refused = entry?.refusal ?? null;
    if (editor.saveRefused !== refused) store.setSaveRefused(key, refused);
  }
}

/**
 * Keep the worktree of every entry not saved yet subscribed, as a save in flight does, so the
 * server serves it when the entry is retried: a switch away unsubscribes it once they are all
 * saved, or need the user.
 */
function syncHeldWorktrees(): void {
  const wanted = new Map<string, WorktreeRef>();
  for (const entry of entries.values()) {
    const wt = entryWorktree(entry);
    if (entry.status !== "review" && wt) wanted.set(entry.id, wt);
  }
  const same = (a: WorktreeRef | undefined, b: WorktreeRef | undefined) =>
    a !== undefined && b !== undefined && sameWorktreeRef(a, b);
  // Held before any is released, so a worktree another entry holds is never let go in between.
  for (const [id, wt] of wanted) if (!same(heldWorktrees.get(id), wt)) holdWorktree(wt);
  for (const [id, wt] of heldWorktrees) if (!same(wanted.get(id), wt)) releaseWorktree(wt);
  heldWorktrees.clear();
  for (const [id, wt] of wanted) heldWorktrees.set(id, wt);
}

/**
 * A save is about to be sent for the editor `editor`; it replaces the editor's earlier entry.
 * `stored` resolves once it is stored (or failing to store it was reported).
 */
export function addOutboxEntry(
  editor: EditorFileEntry,
  save: Pick<
    OutboxEntry,
    "editorKey" | "server" | "filePath" | "worktreePath" | "base" | "content" | "options"
  >,
  status: "sending" | "queued" | "review",
): { entry: OutboxEntry; stored: Promise<void> } {
  // Same id as the save it replaces, so its stored record is overwritten, not left behind. One
  // replacing a recovered save stays recovered: its edits still go back to an earlier session.
  const previous = entryOfInstance(editor.instanceId);
  if (previous) entries.delete(previous.id);
  const entry: OutboxEntry = {
    ...save,
    id: previous?.id ?? crypto.randomUUID(),
    instanceId: editor.instanceId,
    ownerId,
    seq: nextSeq++,
    status,
    disk: null,
    // Its editor goes on showing why the last save was refused until this one is answered.
    ...(status === "sending" && previous?.refusal !== undefined
      ? { refusal: previous.refusal }
      : {}),
    // Kept for review again (its file's tab closed), it is still of unconfirmed origin.
    ...(status === "review" && previous?.takenFrom !== undefined
      ? { takenFrom: previous.takenFrom }
      : {}),
  };
  entries.set(entry.id, entry);
  const stored = persist(entry);
  entriesChanged();
  return { entry, stored };
}

/** Whether `editor` has a save waiting for a retry: its next save must go through the outbox. */
export function hasQueuedSave(editor: EditorFileEntry): boolean {
  return isWaiting(entryOfInstance(editor.instanceId));
}

function isWaiting(entry: OutboxEntry | undefined): boolean {
  return entry?.status === "queued" || entry?.status === "retrying";
}

/** The server wrote `entry` (as `written`, which may be formatted). */
export function outboxSaveWritten(entry: OutboxEntry, written: string): void {
  // A late response of a save older than one already confirmed says nothing about the disk now.
  if ((confirmedSeq.get(entry.instanceId) ?? 0) > entry.seq) return;
  confirmedSeq.set(entry.instanceId, entry.seq);
  if (entries.get(entry.id) === entry) {
    removeEntry(entry);
    return;
  }
  // A newer save of the same editor replaced it while it was in flight: that one's edits were
  // made on this content, which is now on disk.
  const newer = entryOfInstance(entry.instanceId);
  if (newer && newer.seq > entry.seq) {
    newer.base = written;
    void persist(newer);
  }
}

/**
 * Sending `entry` failed with `err`: queue it for a retry, or keep it for review if the server
 * refused, even while its editor is open: the editor may unmount (a worktree switch, its tab
 * closing) before it saves again. A retry the server refused because the file changed since it
 * was read is queued, to merge again.
 */
export function outboxSaveFailed(entry: OutboxEntry, err: unknown): void {
  if (entries.get(entry.id) !== entry) return;
  if (!isRetriableSaveError(err) && !isDiskChangedError(err)) {
    toReview(entry, null, refusalReason(err));
    return;
  }
  entry.status = "queued";
  delete entry.refusal;
  void persist(entry);
  entriesChanged();
  if (isGone(entry)) {
    settleGoneSaves();
    return;
  }
  // Saves fail on every autosave while the server is down; that must not keep pushing the retry.
  ensureRetryScheduled();
}

/**
 * The editor `editorKey` (`editor`, of `worktree`) is closing. Edits a move carried over went
 * with it. Those of a file deleted on disk, in the file's own tab, are kept for review, as it shows them now
 * (autosave stopped with the deletion), and shown again when the file's tab next opens (at the
 * latest after a reload): only the user gives them up, by discarding them or deleting the file in
 * Loxel.
 */
export function outboxEditorClosing(
  editorKey: EditorKey,
  editor: EditorFileEntry,
  worktree: WorktreeRef | null,
): void {
  const entry = entryOfInstance(editor.instanceId);
  if (!editor.deleted && !editor.movedTo) {
    // A refused save of another view (a compare or diff side), which does not take it over when it
    // mounts again: shown once the view is gone, as a closed editor's refused save is. A pending
    // autosave flushed meanwhile replaces it, and is shown when it fails.
    if (
      entry?.status === "review" &&
      entry.refusal !== undefined &&
      !isFileTabKey(editorKey, editor)
    ) {
      queueMicrotask(() => {
        if (entries.get(entry.id) === entry && !ownerEditor(entry)) {
          toReview(entry, entry.disk, entry.refusal);
        }
      });
    }
    return;
  }
  // Kept only for the file's own tab, which a reload brings back: another view of the file (a
  // compare or diff side) gives its edits up with it.
  if (editor.movedTo || !isFileTabKey(editorKey, editor)) {
    if (entry) removeEntry(entry);
    return;
  }
  if (editor.state === "clean") return;
  const content =
    editor.takePendingEdit?.()?.content ?? editor.getEditorContent?.() ?? entry?.content;
  if (content === undefined || content === null) return;
  addOutboxEntry(
    editor,
    {
      editorKey,
      server: editor.server,
      filePath: editor.filePath,
      worktreePath: worktree?.path ?? null,
      base: diskBase(editor),
      content,
      options: entry?.options,
    },
    "review",
  );
}

/**
 * The files of `worktreePath` whose edits Loxel holds unsaved, which removing the worktree in Loxel
 * discards: this window's editors of `server`'s files in it that have unsaved changes, and the
 * outbox's saves of the worktree not in flight, this window's and every other window's (read from
 * storage).
 */
export async function unsavedFilesOf(server: ServerId, worktreePath: string): Promise<string[]> {
  const files = new Set<string>();
  for (const editor of useEditorStateStore.getState().files.values()) {
    if (editor.server !== server || editor.state === "clean") continue;
    if (isWithin(editor.filePath, worktreePath)) files.add(editor.filePath);
  }
  const stored = await (storage?.load() ?? Promise.resolve([])).catch((error: unknown) => {
    log.warn("Failed to read other windows' unsaved edits", { error });
    return [];
  });
  // This window's are current in memory; the stored copies may lag behind. One stored with no
  // server may be of any: it counts, so that a removal never discards it unannounced.
  const others = stored.filter((entry) => entry.ownerId !== ownerId);
  for (const entry of [...entries.values(), ...others]) {
    if (entry.server !== undefined && entry.server !== server) continue;
    if (entry.worktreePath === worktreePath && entry.status !== "sending") {
      files.add(entry.filePath);
    }
  }
  return [...files];
}

/** Forget the saves of a file of `server`, or of everything under a folder, that the user deleted. */
export function forgetOutboxPath(server: ServerId, path: string): void {
  for (const entry of entries.values()) {
    if (entry.server !== server) continue;
    if (entry.filePath === path || entry.filePath.startsWith(`${path}/`)) removeEntry(entry);
  }
}

// -- Taking over a save in a reopened tab --

/**
 * A save of `server`'s `filePath` that its file tab can show when it opens: the newest one whose
 * editor is gone and which is not being sent. Pure; the tab takes it over with `adoptOutboxEntry`.
 */
export function findAdoptableEntry(server: ServerId, filePath: string): OutboxEntry | null {
  let found: OutboxEntry | null = null;
  for (const entry of entries.values()) {
    if (entry.server !== server || entry.filePath !== filePath || ownerEditor(entry)) continue;
    if (entry.status === "sending" || entry.status === "retrying") continue;
    if (!found || entry.seq > found.seq) found = entry;
  }
  return found;
}

/**
 * The editor `editorKey` mounted showing `entry`'s content: it takes over the save, as unsaved
 * edits on the entry's base, or in conflict with the disk version the save could not merge with.
 * A save in review stays in review; one of unconfirmed origin (`takenFrom`) is always shown as a
 * conflict, with the file's disk version read afresh.
 */
export function adoptOutboxEntry(editorKey: EditorKey, entry: OutboxEntry): void {
  const store = useEditorStateStore.getState();
  store.adoptQueuedEdit(editorKey, {
    base: entry.base,
    disk: entry.status === "review" ? entry.disk : null,
    conflict: entry.takenFrom !== undefined,
  });
  const editor = store.files.get(editorKey);
  if (!editor || entries.get(entry.id) !== entry) return;
  entry.instanceId = editor.instanceId;
  entry.editorKey = editorKey;
  entry.ownerId = ownerId;
  void persist(entry);
  entriesChanged();
  if (entry.status === "queued") scheduleRetry(0);
  if (entry.takenFrom) void showDiskOfTakenOver(entry);
  else if (entry.status === "review" && entry.refusal !== undefined) {
    void mergeDiskIntoAdopted(entry);
  }
}

/**
 * A save of unconfirmed origin its file's tab took over, shown as a conflict: read the file for the
 * conflict's disk version, which the user can take instead of the edits. A file missing from disk
 * is marked deleted. One the server does not serve yet is read again once it does, by the refetch
 * of open editors that follows a worktree being served.
 */
async function showDiskOfTakenOver(entry: OutboxEntry): Promise<void> {
  const disk = await readDisk(entry);
  const editor = entries.get(entry.id) === entry ? ownerEditor(entry) : undefined;
  if (editor?.state !== "diverged") return;
  const store = useEditorStateStore.getState();
  if (disk.kind === "missing") store.setDeleted(entry.editorKey, true);
  else if (disk.kind === "content" && disk.content !== editor.diskContent) {
    store.setDiskContent(entry.editorKey, disk.content);
  }
}

/**
 * A refused save its file's tab took over: the file may have changed while no editor of it was
 * open. Its disk version goes through the editor like any external change, which merges it or
 * shows the conflict, so the next save does not overwrite it.
 */
async function mergeDiskIntoAdopted(entry: OutboxEntry): Promise<void> {
  const disk = await readDisk(entry);
  if (disk.kind !== "content" || disk.content === entry.base) return;
  if (entries.get(entry.id) !== entry || ownerEditor(entry)?.state !== "dirty") return;
  useEditorStateStore.getState().handleDiskChange(entry.editorKey, [], disk.content);
}

// -- Retrying --

function retryDelay(): number {
  return RETRY_DELAYS_MS[Math.min(failedRounds, RETRY_DELAYS_MS.length - 1)] ?? 30_000;
}

function scheduleRetry(delayMs: number): void {
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = setTimeout(() => {
    retryTimer = null;
    void retryQueuedSaves();
  }, delayMs);
}

/**
 * `unreachable` ends the retry round; `unavailable` (this save only) lets it go on; `changed`, the
 * file changed between reading and writing it, asks for another pass to merge again.
 */
type RetryOutcome = "done" | "unreachable" | "unavailable" | "changed";

/**
 * Retry every queued save, oldest first, stopping at the first one the server cannot take.
 * Resolves when the retry, and any asked for while it ran, is over.
 */
export function retryQueuedSaves(): Promise<void> {
  if (currentRun) {
    runAgain = true;
    return currentRun;
  }
  currentRun = (async () => {
    let failed = false;
    let again = false;
    let changedPasses = 0;
    do {
      runAgain = false;
      const outcome = await retryRound();
      // A file another program keeps rewriting would otherwise be read and merged in a tight
      // loop: after a few passes it waits for the backoff like a failure.
      if (outcome === "changed") changedPasses++;
      failed = outcome === "failed" || changedPasses >= MAX_CHANGED_PASSES;
      again = runAgain || outcome === "changed";
    } while (again && !failed);
    failedRounds = failed ? failedRounds + 1 : 0;
  })().finally(() => {
    currentRun = null;
    reportRecovered();
    // Saves of a worktree that went while they were retried are settled instead.
    settleGoneSaves();
    if ([...entries.values()].some(isRetriable)) {
      scheduleRetry(retryDelay());
    }
  });
  return currentRun;
}

/**
 * Whether `entry` waits for a retry the window can send: queued, of a worktree not gone, and of a
 * server the window is connected to (its requests go to the window's connection, `api`).
 */
function isRetriable(entry: OutboxEntry): boolean {
  return entry.status === "queued" && !isGone(entry) && hasConnection(entry.server);
}

/** Make sure a retry is coming, without cutting short the backoff while the server is away. */
export function ensureRetryScheduled(): void {
  if (currentRun) runAgain = true;
  else if (!retryTimer) scheduleRetry(retryDelay());
}

/**
 * One pass over the queued saves: `failed` when one of them failed again, `changed` when one found
 * the file changed between its read and its write and needs another pass. Stops when the server
 * cannot be reached, but goes on past a save whose path it does not serve right now (a worktree
 * not subscribed yet, or removed), so that one cannot hold up the others.
 */
async function retryRound(): Promise<"done" | "failed" | "changed"> {
  const queued = [...entries.values()].filter((e) => isRetriable(e)).sort((a, b) => a.seq - b.seq);
  let failed = false;
  let changed = false;
  for (const entry of queued) {
    if (entries.get(entry.id) !== entry || !isRetriable(entry)) continue;
    const editor = ownerEditor(entry);
    const outcome = editor ? await retryInEditor(entry, editor) : await retryClosed(entry);
    if (outcome === "unreachable") return "failed";
    if (outcome === "unavailable") failed = true;
    if (outcome === "changed") changed = true;
  }
  if (failed) return "failed";
  return changed ? "changed" : "done";
}

type DiskRead =
  | { kind: "content"; content: string }
  | { kind: "missing" }
  | { kind: "unreachable" }
  | { kind: "unavailable" }
  | { kind: "error" };

/** Read the file for a retry. Errors other than a missing file count as the server being away. */
async function readDisk(entry: OutboxEntry): Promise<DiskRead> {
  try {
    const { content } = await api.getFileContentByPath(
      entry.server,
      entry.filePath,
      entryWorktree(entry),
    );
    return { kind: "content", content };
  } catch (error) {
    if (isFileMissingError(error)) return { kind: "missing" };
    const reason = retryReason(error);
    if (reason === "unreachable") return { kind: "unreachable" };
    if (reason === "unavailable") return { kind: "unavailable" };
    log.error("Failed to read a file to retry its save", { path: entry.filePath, error });
    return { kind: "error" };
  }
}

/**
 * Retry a save whose editor is still open. The disk is read first: unchanged since the edits
 * started, the save is sent again; changed, it goes through the editor's state machine like any
 * external change, which merges it into the editor (whose content is then sent) or shows the
 * conflict banner. A save recovered from an earlier session is not merged: a changed disk shows
 * the conflict. The write goes through only if the disk still holds what was read.
 */
async function retryInEditor(entry: OutboxEntry, editor: EditorFileEntry): Promise<RetryOutcome> {
  if (editor.state === "diverged" || editor.deleted || editor.movedTo) {
    toReview(entry, editor.state === "diverged" ? editor.diskContent : null);
    return "done";
  }
  entry.status = "retrying";
  const disk = await readDisk(entry);
  // The editor may have saved again (replacing the entry) or closed during the read.
  if (entries.get(entry.id) !== entry) return "done";
  entry.status = "queued";
  const current = ownerEditor(entry);
  if (disk.kind === "unreachable" || disk.kind === "unavailable") return disk.kind;
  if (disk.kind === "error") {
    toReview(entry, null);
    return "done";
  }
  if (!current) return "done"; // retried as a closed editor's save next
  // Back to clean during the read (the user accepted the disk version): nothing to save.
  if (current.state === "clean") {
    removeEntry(entry);
    return "done";
  }
  const store = useEditorStateStore.getState();
  if (disk.kind === "missing") {
    store.setDeleted(entry.editorKey, true);
    toReview(entry, null);
    return "done";
  }
  if (disk.content !== entry.base && disk.content !== entry.content) {
    if (recovered.has(entry.id)) {
      store.adoptQueuedEdit(entry.editorKey, { base: entry.base, disk: disk.content });
      toReview(entry, disk.content);
      return "done";
    }
    store.handleDiskChange(entry.editorKey, [], disk.content);
    const after = ownerEditor(entry);
    if (!after || after.state === "diverged") {
      toReview(entry, disk.content);
      return "done";
    }
  }
  // Send what the editor shows now, which can be ahead of the entry (typing since the last
  // autosave) or merged with the disk: writing the entry's older content would make its echo
  // look like a change to merge back into the editor, undoing that typing. Taking it also cancels
  // the editor's pending autosave.
  const now = ownerEditor(entry);
  const pending = now?.takePendingEdit?.();
  const result = await postEditorContent(
    entry.server,
    entry.filePath,
    pending?.content ?? now?.getEditorContent?.() ?? entry.content,
    entryWorktree(entry),
    // The entry's options, not the pending edit's: those are always the explicit-save ones, and
    // a queued autosave must not format unless format-on-autosave is on.
    entry.options,
    entry.editorKey,
    disk.content,
  );
  if (!result.ok && isDiskChangedError(result.error)) return "changed";
  return hasQueuedSave(current) ? "unavailable" : "done";
}

/**
 * Retry a save whose editor closed. Written as it is when the disk still holds its base, merged
 * onto the disk version otherwise, and only if the disk still holds what was read; a conflict, a
 * missing file or a refusal is shown to the user. A save recovered from an earlier session is
 * only written onto its base: it may be days old, made on another version of the file (a branch
 * switch, a rebase), so a changed disk shows it instead.
 */
async function retryClosed(entry: OutboxEntry): Promise<RetryOutcome> {
  entry.status = "sending"; // a tab opening meanwhile shows the disk, then this write
  const disk = await readDisk(entry);
  if (entries.get(entry.id) !== entry) return "done";
  if (disk.kind === "unreachable" || disk.kind === "unavailable") {
    entry.status = "queued";
    return disk.kind;
  }
  if (disk.kind === "missing" || disk.kind === "error") {
    toReview(entry, null);
    return "done";
  }
  if (disk.content === entry.content) {
    savedClosed(entry);
    return "done";
  }
  let content = entry.content;
  if (disk.content !== entry.base) {
    const merged =
      entry.base === null || recovered.has(entry.id)
        ? null
        : threeWayMerge(entry.base, entry.content, disk.content);
    if (!merged?.ok) {
      toReview(entry, disk.content);
      return "done";
    }
    content = merged.merged;
  }
  try {
    await api.writeFileContent(entry.server, {
      path: entry.filePath,
      content,
      // Its echo reaches no editor of this save; other editors of the file see a change.
      nonce: crypto.randomUUID(),
      worktree: entryWorktree(entry) ?? undefined,
      format: entry.options?.format,
      formattingSettings: entry.options?.formattingSettings,
      expectedContent: disk.content,
    });
  } catch (error) {
    if (entries.get(entry.id) !== entry) return "done";
    if (isDiskChangedError(error)) {
      entry.status = "queued";
      return "changed";
    }
    const reason = retryReason(error);
    if (reason) {
      entry.status = "queued";
      return reason;
    }
    log.error("The server refused a queued save", { path: entry.filePath, error });
    toReview(entry, null, refusalReason(error));
    return "done";
  }
  savedClosed(entry);
  return "done";
}

function savedClosed(entry: OutboxEntry): void {
  if (recovered.has(entry.id)) recoveredSaved.push(getDisplayFilename(entry.filePath));
  log.info("Saved a queued edit of a closed editor", { path: entry.filePath });
  removeEntry(entry);
}

/** What the editor says a refused save failed with. */
function refusalReason(err: unknown): string {
  return err instanceof Error && err.message ? err.message : "the server refused it";
}

/**
 * The save needs the user: keep it, and show it in the file's tab. `refusal`: the server refused
 * it, for this reason.
 */
function toReview(entry: OutboxEntry, disk: string | null, refusal?: string): void {
  entry.status = "review";
  entry.disk = disk;
  if (refusal === undefined) delete entry.refusal;
  else entry.refusal = refusal;
  recovered.delete(entry.id);
  void persist(entry);
  entriesChanged();
  // An open editor already shows the edits (with its conflict, deleted or refused-save banner).
  if (ownerEditor(entry)) return;
  const name = getDisplayFilename(entry.filePath);
  const tabKey = fileEditorKey(entry.server, entry.filePath);
  const tab = useEditorStateStore.getState().files.get(tabKey);
  if (tab) {
    // The file's tab is open (the save came from a closed compare side, or the tab was reopened
    // while the save was being sent): show the edits there if it has none of its own.
    const applied =
      tab.state === "clean" ? tab.applyMergedContent?.(entry.content, true) : undefined;
    if (typeof applied === "string") {
      adoptOutboxEntry(tabKey, entry);
    } else {
      showToast(`Unsaved edits to ${name} are kept until its tab is reopened`, "info");
    }
    return;
  }
  showToast(reviewMessage(entry, name, disk), "info");
  void openFile(entry.server, {
    filePath: entry.filePath,
    worktreePath: entry.worktreePath ?? undefined,
    focus: false,
  });
}

/** What the user is told when `entry` is kept for review with no editor showing it. */
function reviewMessage(entry: OutboxEntry, name: string, disk: string | null): string {
  // Nothing was tried for those: they wait for the user only because their server is unknown.
  if (entry.takenFrom === "earlier-version") {
    return `Unsaved edits to ${name} from an earlier version of Loxel are kept for review`;
  }
  if (entry.takenFrom === "other-server") {
    return `Unsaved edits to ${name} from another Loxel server are kept for review`;
  }
  if (disk === null) return `Unsaved edits to ${name} could not be saved`;
  return `Unsaved edits to ${name} conflict with changes on disk`;
}

function reportRecovered(): void {
  if (recoveredSaved.length === 0) return;
  showToast(`Saved edits from the last session to ${recoveredSaved.join(", ")}`, "info");
  recoveredSaved.length = 0;
}

// -- Setup --

/** Open the IndexedDB store, or null where there is none (tests). */
function indexedDbStorage(): OutboxStorage | null {
  if (typeof indexedDB === "undefined") return null;
  const STORE = "entries";
  const db = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("loxel-save-outbox", 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: "id" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB open failed"));
  });
  /** Resolves once the write's transaction commits; rejects if it fails or aborts. */
  const write = async (op: (store: IDBObjectStore) => void): Promise<void> => {
    const transaction = (await db).transaction(STORE, "readwrite");
    await new Promise<void>((resolve, reject) => {
      const failed = () => reject(transaction.error ?? new Error("IndexedDB write failed"));
      transaction.oncomplete = () => resolve();
      transaction.onerror = failed;
      transaction.onabort = failed;
      op(transaction.objectStore(STORE));
    });
  };
  return {
    load: async () => {
      const d = await db;
      return new Promise<StoredOutboxEntry[]>((resolve, reject) => {
        const request = d.transaction(STORE, "readonly").objectStore(STORE).getAll();
        request.onsuccess = () => resolve(request.result.filter(isOutboxEntry));
        request.onerror = () => reject(request.error ?? new Error("IndexedDB read failed"));
      });
    },
    put: (entry) => write((store) => store.put(entry)),
    remove: (id) => write((store) => store.delete(id)),
  };
}

function isOutboxEntry(value: unknown): value is StoredOutboxEntry {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string" &&
    typeof v.instanceId === "string" &&
    typeof v.ownerId === "string" &&
    // An editor key stored by an older version matches no editor; adoption re-keys its entry.
    typeof v.editorKey === "string" &&
    (v.server === undefined || typeof v.server === "string") &&
    typeof v.filePath === "string" &&
    (typeof v.worktreePath === "string" || v.worktreePath === null) &&
    (typeof v.base === "string" || v.base === null) &&
    typeof v.content === "string" &&
    typeof v.seq === "number" &&
    (typeof v.disk === "string" || v.disk === null) &&
    (v.refusal === undefined || typeof v.refusal === "string") &&
    (v.takenFrom === undefined ||
      v.takenFrom === "earlier-version" ||
      v.takenFrom === "other-server") &&
    (v.status === "sending" ||
      v.status === "queued" ||
      v.status === "retrying" ||
      v.status === "review")
  );
}

/**
 * What the Web Locks held or waited for under `prefix` name, the prefix cut off; null when the API
 * is missing.
 */
async function lockedNames(prefix: string): Promise<Set<string> | null> {
  if (typeof navigator === "undefined" || !navigator.locks) return null;
  const { held = [], pending = [] } = await navigator.locks.query();
  const names = [...held, ...pending].map((lock) => lock.name ?? "");
  return new Set(names.filter((n) => n.startsWith(prefix)).map((n) => n.slice(prefix.length)));
}

/**
 * Hold a Web Lock named `name` until `until` settles (the window going away, by default). Resolves
 * once it is held.
 */
function holdLock(
  name: string,
  mode: LockMode,
  until: Promise<unknown> = new Promise<never>(() => {}),
): Promise<void> {
  if (typeof navigator === "undefined" || !navigator.locks) return Promise.resolve();
  const held = Promise.withResolvers<void>();
  void navigator.locks.request(name, { mode }, () => {
    held.resolve();
    return until;
  });
  return held.promise;
}

/** Run `fn` while no other window is recovering entries. */
async function exclusively<T>(fn: () => Promise<T>): Promise<T> {
  if (typeof navigator === "undefined" || !navigator.locks) return fn();
  return navigator.locks.request(`${LOCK_PREFIX}recovery`, fn);
}

/**
 * Subscribe the worktrees of recovered saves until they are saved, as switching away from a
 * worktree waits for its saves. Before the window subscribes the worktree it shows, which stays
 * the last one subscribed.
 */
function subscribeRecoveredWorktrees(taken: readonly OutboxEntry[]): void {
  const worktrees = new Map<WorktreeRefKey, WorktreeRef>();
  for (const entry of taken) {
    const wt = entryWorktree(entry);
    if (entry.status !== "review" && wt) worktrees.set(formatWorktreeRef(wt), wt);
  }
  for (const wt of worktrees.values()) {
    const connection = api.wsClientOf(wt.server);
    connection.subscribeWorktree(wt);
    onWorktreeSavesDrained(wt, () => {
      const active = useWorktreeStore.getState().activeWorktree;
      if (!active || !sameWorktreeRef(active, wt)) connection.unsubscribeWorktree(wt);
    });
  }
}

/**
 * Once the project lists are known, settle the recovered saves of worktrees no longer in them
 * (gone while Loxel was closed, so not discarded in it), as a worktree going while Loxel runs
 * settles its own. A failed fetch leaves no project of its server listed, and a project the server
 * could not initialize (a volume not mounted yet) lists no worktree: then nothing is known to be
 * gone.
 * Their worktrees were subscribed already, before the one the window shows; a gone one only
 * answers with an error.
 */
async function settleRecoveredOfGoneWorktrees(taken: readonly OutboxEntry[]): Promise<void> {
  await whenProjectsLoaded();
  const { projects } = useProjectStore.getState();
  for (const entry of taken) {
    const wt = entryWorktree(entry);
    if (!wt || isListedWorktree(wt)) continue;
    // A server that listed nothing (its fetch failed) says nothing is gone.
    if (!projects.some((project) => project.server === wt.server)) continue;
    const project = projectOf(wt, projects);
    if (project && project.worktrees.length === 0) continue;
    const key = formatWorktreeRef(wt);
    goneWorktrees.set(key, goneWorktrees.get(key) === true);
  }
  settleGoneSaves();
}

/**
 * Load the outbox and take over the entries of windows that are gone (an earlier run, or a
 * window that crashed), then start retrying. The entries of the server the window is connected
 * to are taken as they are. Those of another server are left in storage, untouched, while a
 * window connected to it may be open (each holds a lock named after its server, and one that does
 * not know its server yet could be connected to any); with none open, no window would ever show
 * them, so they are taken as the window's server's, like one stored before entries named their
 * server (the only one an origin served then): the edits most likely were made on the same files,
 * as when the server's ID changed with its state directory, but since that can't be checked they
 * are only shown for review, never written without the user (`takenFrom`). Call once, before the
 * editors mount, so a tab restored with the layout can take over its file's entry.
 */
export async function initSaveOutbox(
  options: { storage?: OutboxStorage | null } = {},
): Promise<void> {
  storage = options.storage === undefined ? indexedDbStorage() : options.storage;
  void holdLock(`${LOCK_PREFIX}${ownerId}`, "exclusive");
  // Until this window holds its server's lock, a window recovering meanwhile can't tell which
  // server's entries it would leave without one.
  const serverLockHeld = Promise.withResolvers<void>();
  void holdLock(`${STARTING_LOCK_PREFIX}${ownerId}`, "shared", serverLockHeld.promise);
  const store = storage;
  const server = await whenLocalServerKnown();
  await holdLock(`${SERVER_LOCK_PREFIX}${server}`, "shared");
  serverLockHeld.resolve();
  const taken = store
    ? await exclusively(async () => {
        const stored = await store.load();
        const live = await lockedNames(LOCK_PREFIX);
        const liveServers = await lockedNames(SERVER_LOCK_PREFIX);
        const starting = await lockedNames(STARTING_LOCK_PREFIX);
        /** Whether a window connected to `from` may be open, which then shows its entries. */
        const othersStarting = [...(starting ?? [])].some((owner) => owner !== ownerId);
        const served = (from: string) => othersStarting || liveServers?.has(from) === true;
        const orphans = stored.flatMap((stored): OutboxEntry[] => {
          if (stored.ownerId === ownerId || live?.has(stored.ownerId)) return [];
          const from = stored.server;
          if (from !== undefined && from !== server && served(from)) return [];
          let takenFrom = stored.takenFrom;
          if (from === undefined) takenFrom = "earlier-version";
          else if (from !== server) takenFrom = "other-server";
          const entry: OutboxEntry = { ...stored, server, ...(takenFrom ? { takenFrom } : {}) };
          if (entry.status !== "review") {
            entry.status = takenFrom ? "review" : "queued";
            delete entry.refusal; // carried by a save in flight when the window went
          }
          return [entry];
        });
        for (const entry of orphans) {
          entry.ownerId = ownerId;
          entry.seq = nextSeq++;
        }
        // Taken over only once stored as this window's, so no other window takes them too.
        await Promise.all(orphans.map((entry) => store.put(entry)));
        return orphans;
      }).catch((error: unknown) => {
        log.error("Failed to load the save outbox", { error });
        return [];
      })
    : [];
  for (const entry of taken) {
    entries.set(entry.id, entry);
    if (entry.status === "queued") recovered.add(entry.id);
  }
  if (taken.length === 0) return;
  log.info("Recovered unsaved edits from an earlier session", { count: taken.length });
  entriesChanged();
  subscribeRecoveredWorktrees(taken);
  void settleRecoveredOfGoneWorktrees(taken);
  scheduleRetry(0);
  // Saves that need the user are shown in their tabs once the app is up.
  for (const entry of taken) {
    if (entry.status === "review") toReview(entry, entry.disk, entry.refusal);
  }
}

/** Test hook: forget every entry and stop retrying, as a new window (page load) starts. */
export function resetSaveOutboxForTests(): void {
  entries.clear();
  entriesChanged();
  ownerId = crypto.randomUUID();
  confirmedSeq.clear();
  recovered.clear();
  recoveredSaved.length = 0;
  goneWorktrees.clear();
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
  failedRounds = 0;
  currentRun = null;
  runAgain = false;
  storage = null;
  storageFailing = false;
}

/** Test hook: the current entries. */
export function outboxEntriesForTests(): OutboxEntry[] {
  return [...entries.values()];
}
