/**
 * The save outbox: every editor save is kept here, in memory and in IndexedDB, until the server
 * confirms it. A save that fails because the server cannot be reached (it is restarting, or not
 * subscribed to the worktree yet) stays queued and is retried on reconnect and on a backoff
 * timer, after reading the file and merging with whatever is on disk by then. It survives its
 * tab closing and the window reloading or quitting. See docs/EDITOR.md, "Save outbox".
 */

import * as api from "@/api/client";
import { showToast } from "@/components/ui/toast";
import { getDisplayFilename } from "@/lib/detached-path";
import { frontendLog } from "@/lib/frontend-logger";
import { openFile } from "@/lib/open-path";
import { type SaveOptions, writeEditorContent } from "@/lib/save-editor-content";
import { threeWayMerge } from "@/lib/three-way-merge";
import { type EditorFileEntry, useEditorStateStore } from "@/store/editor-state";

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
  editorKey: string;
  filePath: string;
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
}

/** Where entries persist between runs. Every method is best effort. */
export interface OutboxStorage {
  load: () => Promise<OutboxEntry[]>;
  put: (entry: OutboxEntry) => void;
  remove: (id: string) => void;
}

/** Retry delays after consecutive failed rounds; the last one repeats. */
const RETRY_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000];
/** A save in flight from an open editor is stored only once it takes this long. */
const STORE_IN_FLIGHT_AFTER_MS = 1_000;
const LOCK_PREFIX = "loxel-save-outbox:";

const ownerId = crypto.randomUUID();
const entries = new Map<string, OutboxEntry>();
let storage: OutboxStorage | null = null;
/** Ids of the entries in storage. */
const storedIds = new Set<string>();
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

/**
 * Why a failed request may succeed later: `unreachable`, the server could not be reached (or
 * answered that it is unavailable); `unavailable`, it does not serve this path right now (a plain
 * 404: the path is in no worktree it has resources for, because it restarted or the window has
 * not subscribed again yet). null for a real answer, such as ENOENT or a refused write.
 */
function retryReason(err: unknown): "unreachable" | "unavailable" | null {
  if (err instanceof TypeError) return "unreachable"; // fetch could not reach the server
  if (!(err instanceof api.ApiError)) return null;
  if (err.status === 404) return err.code === "ENOENT" ? null : "unavailable";
  return err.status === 502 || err.status === 503 || err.status === 504 ? "unreachable" : null;
}

/** Whether a failed save may succeed later: the server was unreachable or not ready for it. */
export function isRetriableSaveError(err: unknown): boolean {
  return retryReason(err) !== null;
}

// -- Entries --

/**
 * Write `entry` to storage. A save in flight from an open editor is kept in memory only, unless
 * `force`d (it is taking a while, or the window is going away): almost all are confirmed within
 * milliseconds, and its editor still holds the content.
 */
function persist(entry: OutboxEntry, force = false): void {
  if (!storage || entries.get(entry.id) !== entry) return;
  const inMemoryOnly = entry.status === "sending" && !storedIds.has(entry.id) && ownerEditor(entry);
  if (inMemoryOnly && !force) return;
  storedIds.add(entry.id);
  storage.put(entry);
}

function removeEntry(entry: OutboxEntry): void {
  if (entries.get(entry.id) !== entry) return;
  entries.delete(entry.id);
  recovered.delete(entry.id);
  if (storedIds.delete(entry.id)) storage?.remove(entry.id);
  syncQueuedFlags();
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
 * nothing left to save (the user accepted the disk version of a conflict).
 */
function onEditorsChanged(): void {
  for (const entry of entries.values()) {
    if (entry.status === "retrying") continue;
    // In flight when its editor closed (an unmount flush): only the outbox holds it now.
    if (entry.status === "sending") persist(entry);
    else if (ownerEditor(entry)?.state === "clean") removeEntry(entry);
  }
  syncQueuedFlags();
}

useEditorStateStore.subscribe(onEditorsChanged);

if (typeof window !== "undefined") {
  window.addEventListener("pagehide", () => {
    for (const entry of entries.values()) persist(entry, true);
  });
}

// The server is back: retry at once. (A save that was in flight when it went away failed with a
// network error and is queued like any other.)
api.wsClient.onReconnect(() => {
  failedRounds = 0;
  scheduleRetry(0);
});

/** Keep each editor's `queued` flag in step with its entry. */
function syncQueuedFlags(): void {
  const store = useEditorStateStore.getState();
  for (const [key, editor] of store.files) {
    const queued = isWaiting(entryOfInstance(editor.instanceId));
    if (editor.queued !== queued) store.setQueued(key, queued);
  }
}

/** A save is about to be sent for the editor `editor`; it replaces the editor's earlier entry. */
export function addOutboxEntry(
  editor: EditorFileEntry,
  save: Pick<
    OutboxEntry,
    "editorKey" | "filePath" | "worktreePath" | "base" | "content" | "options"
  >,
  status: "sending" | "queued",
): OutboxEntry {
  // Same id as the save it replaces, so its stored record is overwritten, not left behind.
  const previous = entryOfInstance(editor.instanceId);
  if (previous) {
    entries.delete(previous.id);
    recovered.delete(previous.id);
  }
  const entry: OutboxEntry = {
    ...save,
    id: previous?.id ?? crypto.randomUUID(),
    instanceId: editor.instanceId,
    ownerId,
    seq: nextSeq++,
    status,
    disk: null,
  };
  entries.set(entry.id, entry);
  persist(entry);
  if (status === "sending") setTimeout(() => persist(entry, true), STORE_IN_FLIGHT_AFTER_MS);
  syncQueuedFlags();
  return entry;
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
    persist(newer);
  }
}

/** Sending `entry` failed with `err`: queue it for a retry, or drop it if the server refused. */
export function outboxSaveFailed(entry: OutboxEntry, err: unknown): void {
  if (entries.get(entry.id) !== entry) return;
  if (!isRetriableSaveError(err)) {
    // An open editor still holds the edits (dirty, as before the outbox); a closed one does not.
    if (ownerEditor(entry)) removeEntry(entry);
    else toReview(entry, null);
    return;
  }
  entry.status = "queued";
  persist(entry);
  syncQueuedFlags();
  // Saves fail on every autosave while the server is down; that must not keep pushing the retry.
  ensureRetryScheduled();
}

/** Forget the entry of an editor whose edits went elsewhere (a move) or were given up (a delete). */
export function forgetOutboxEntry(instanceId: string): void {
  const entry = entryOfInstance(instanceId);
  if (entry) removeEntry(entry);
}

/** Forget the saves of a file, or of everything under a folder, that the user deleted. */
export function forgetOutboxPath(path: string): void {
  for (const entry of entries.values()) {
    if (entry.filePath === path || entry.filePath.startsWith(`${path}/`)) removeEntry(entry);
  }
}

// -- Taking over a save in a reopened tab --

/**
 * A save of `filePath` that its file tab can show when it opens: the newest one whose editor is
 * gone and which is not being sent. Pure; the tab takes it over with `adoptOutboxEntry`.
 */
export function findAdoptableEntry(filePath: string): OutboxEntry | null {
  let found: OutboxEntry | null = null;
  for (const entry of entries.values()) {
    if (entry.filePath !== filePath || ownerEditor(entry)) continue;
    if (entry.status === "sending" || entry.status === "retrying") continue;
    if (!found || entry.seq > found.seq) found = entry;
  }
  return found;
}

/**
 * The editor `editorKey` mounted showing `entry`'s content: it takes over the save, as unsaved
 * edits on the entry's base, or in conflict with the disk version the save could not merge with.
 */
export function adoptOutboxEntry(editorKey: string, entry: OutboxEntry): void {
  const store = useEditorStateStore.getState();
  store.adoptQueuedEdit(editorKey, {
    base: entry.base,
    disk: entry.status === "review" ? entry.disk : null,
  });
  const editor = store.files.get(editorKey);
  if (!editor || entries.get(entry.id) !== entry) return;
  entry.instanceId = editor.instanceId;
  entry.editorKey = editorKey;
  entry.ownerId = ownerId;
  persist(entry);
  syncQueuedFlags();
  if (entry.status === "queued") scheduleRetry(0);
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

/** `unreachable` ends the retry round; `unavailable` (this save only) lets it go on. */
type RetryOutcome = "done" | "unreachable" | "unavailable";

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
    do {
      runAgain = false;
      failed = await retryRound();
    } while (runAgain && !failed);
    failedRounds = failed ? failedRounds + 1 : 0;
  })().finally(() => {
    currentRun = null;
    reportRecovered();
    if ([...entries.values()].some((e) => e.status === "queued")) scheduleRetry(retryDelay());
  });
  return currentRun;
}

/** Make sure a retry is coming, without cutting short the backoff while the server is away. */
export function ensureRetryScheduled(): void {
  if (currentRun) runAgain = true;
  else if (!retryTimer) scheduleRetry(retryDelay());
}

/**
 * One pass over the queued saves; true when one of them failed again. Stops when the server
 * cannot be reached, but goes on past a save whose path it does not serve right now (a worktree
 * not subscribed yet, or removed), so that one cannot hold up the others.
 */
async function retryRound(): Promise<boolean> {
  const queued = [...entries.values()]
    .filter((e) => e.status === "queued")
    .sort((a, b) => a.seq - b.seq);
  let failed = false;
  for (const entry of queued) {
    if (entries.get(entry.id) !== entry || entry.status !== "queued") continue;
    const editor = ownerEditor(entry);
    const outcome = editor ? await retryInEditor(entry, editor) : await retryClosed(entry);
    if (outcome === "unreachable") return true;
    if (outcome === "unavailable") failed = true;
  }
  return failed;
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
    const { content } = await api.getFileContentByPath(entry.filePath, entry.worktreePath);
    return { kind: "content", content };
  } catch (error) {
    if (api.isFileMissingError(error)) return { kind: "missing" };
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
 * conflict banner.
 */
async function retryInEditor(entry: OutboxEntry, editor: EditorFileEntry): Promise<RetryOutcome> {
  if (editor.state === "diverged" || editor.deleted || editor.movedTo) {
    toReview(entry, null);
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
    store.handleDiskChange(entry.editorKey, [], disk.content);
    const after = ownerEditor(entry);
    if (!after || after.state === "diverged") {
      toReview(entry, null);
      return "done";
    }
  }
  // Send what the editor shows now, which can be ahead of the entry (typing since the last
  // autosave) or merged with the disk: writing the entry's older content would make its echo
  // look like a change to merge back into the editor, undoing that typing. Taking it also cancels
  // the editor's pending autosave.
  const now = ownerEditor(entry);
  const pending = now?.takePendingEdit?.();
  await writeEditorContent(
    entry.filePath,
    pending?.content ?? now?.getEditorContent?.() ?? entry.content,
    entry.worktreePath,
    // The entry's options, not the pending edit's: those are always the explicit-save ones, and
    // a queued autosave must not format unless format-on-autosave is on.
    entry.options,
    entry.editorKey,
  );
  return hasQueuedSave(current) ? "unavailable" : "done";
}

/**
 * Retry a save whose editor closed. Written as it is when the disk still holds its base, merged
 * onto the disk version otherwise; a conflict, a missing file or a refusal is shown to the user.
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
      entry.base === null ? null : threeWayMerge(entry.base, entry.content, disk.content);
    if (!merged?.ok) {
      toReview(entry, disk.content);
      return "done";
    }
    content = merged.merged;
  }
  try {
    await api.writeFileContent({
      path: entry.filePath,
      content,
      // Its echo reaches no editor of this save; other editors of the file see a change.
      nonce: crypto.randomUUID(),
      worktreePath: entry.worktreePath ?? undefined,
      format: entry.options?.format,
      formattingSettings: entry.options?.formattingSettings,
    });
  } catch (error) {
    if (entries.get(entry.id) !== entry) return "done";
    const reason = retryReason(error);
    if (reason) {
      entry.status = "queued";
      return reason;
    }
    log.error("The server refused a queued save", { path: entry.filePath, error });
    toReview(entry, null);
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

/** The save needs the user: keep it, and show it in the file's tab. */
function toReview(entry: OutboxEntry, disk: string | null): void {
  entry.status = "review";
  entry.disk = disk;
  recovered.delete(entry.id);
  persist(entry);
  syncQueuedFlags();
  // An open editor already shows the edits (with its conflict or deleted banner).
  if (ownerEditor(entry)) return;
  const name = getDisplayFilename(entry.filePath);
  const tab = useEditorStateStore.getState().files.get(entry.filePath);
  if (tab) {
    // The file's tab is open (the save came from a closed compare side, or the tab was reopened
    // while the save was being sent): show the edits there if it has none of its own.
    const applied =
      tab.state === "clean" ? tab.applyMergedContent?.(entry.content, true) : undefined;
    if (typeof applied === "string") {
      adoptOutboxEntry(entry.filePath, entry);
    } else {
      showToast(`Unsaved edits to ${name} are kept until its tab is reopened`, "info");
    }
    return;
  }
  showToast(
    disk === null
      ? `Unsaved edits to ${name} could not be saved`
      : `Unsaved edits to ${name} conflict with changes on disk`,
    "info",
  );
  void openFile({
    filePath: entry.filePath,
    worktreePath: entry.worktreePath ?? undefined,
    focus: false,
  });
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
  // Logged once: a broken database fails every write the same way.
  let failed = false;
  const write = (op: (store: IDBObjectStore) => void): void => {
    if (failed) return;
    db.then((d) => op(d.transaction(STORE, "readwrite").objectStore(STORE))).catch(
      (error: unknown) => {
        failed = true;
        log.error("Failed to store the save outbox; waiting saves are kept in memory only", {
          error,
        });
      },
    );
  };
  return {
    load: async () => {
      const d = await db;
      return new Promise<OutboxEntry[]>((resolve, reject) => {
        const request = d.transaction(STORE, "readonly").objectStore(STORE).getAll();
        request.onsuccess = () => resolve(request.result.filter(isOutboxEntry));
        request.onerror = () => reject(request.error ?? new Error("IndexedDB read failed"));
      });
    },
    put: (entry) => write((store) => store.put(entry)),
    remove: (id) => write((store) => store.delete(id)),
  };
}

function isOutboxEntry(value: unknown): value is OutboxEntry {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string" &&
    typeof v.instanceId === "string" &&
    typeof v.ownerId === "string" &&
    typeof v.editorKey === "string" &&
    typeof v.filePath === "string" &&
    (typeof v.worktreePath === "string" || v.worktreePath === null) &&
    (typeof v.base === "string" || v.base === null) &&
    typeof v.content === "string" &&
    typeof v.seq === "number" &&
    (v.status === "sending" ||
      v.status === "queued" ||
      v.status === "retrying" ||
      v.status === "review")
  );
}

/**
 * Owners whose window is still open. Each window holds a Web Lock named after its owner id for
 * its lifetime; null when the API is missing, and then every other owner counts as gone.
 */
async function liveOwners(): Promise<Set<string> | null> {
  if (typeof navigator === "undefined" || !navigator.locks) return null;
  const { held = [], pending = [] } = await navigator.locks.query();
  const names = [...held, ...pending].map((lock) => lock.name ?? "");
  return new Set(
    names.filter((n) => n.startsWith(LOCK_PREFIX)).map((n) => n.slice(LOCK_PREFIX.length)),
  );
}

/** Run `fn` while no other window is recovering entries. */
async function exclusively<T>(fn: () => Promise<T>): Promise<T> {
  if (typeof navigator === "undefined" || !navigator.locks) return fn();
  return navigator.locks.request(`${LOCK_PREFIX}recovery`, fn);
}

/**
 * Load the outbox and take over the entries of windows that are gone (an earlier run, or a
 * window that crashed), then start retrying. Call once, before the editors mount, so a tab
 * restored with the layout can take over its file's entry.
 */
export async function initSaveOutbox(
  options: { storage?: OutboxStorage | null } = {},
): Promise<void> {
  storage = options.storage === undefined ? indexedDbStorage() : options.storage;
  if (typeof navigator !== "undefined" && navigator.locks) {
    // Held until the window goes away.
    void navigator.locks.request(`${LOCK_PREFIX}${ownerId}`, () => new Promise<never>(() => {}));
  }
  const store = storage;
  const taken = store
    ? await exclusively(async () => {
        const stored = await store.load();
        const live = await liveOwners();
        const orphans = stored.filter((e) => e.ownerId !== ownerId && !live?.has(e.ownerId));
        for (const entry of orphans) {
          entry.ownerId = ownerId;
          if (entry.status !== "review") entry.status = "queued";
          entry.seq = nextSeq++;
          store.put(entry);
          storedIds.add(entry.id);
        }
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
  scheduleRetry(0);
  // Saves that need the user are shown in their tabs once the app is up.
  for (const entry of taken) if (entry.status === "review") toReview(entry, entry.disk);
}

/** Test hook: forget every entry and stop retrying. */
export function resetSaveOutboxForTests(): void {
  entries.clear();
  storedIds.clear();
  confirmedSeq.clear();
  recovered.clear();
  recoveredSaved.length = 0;
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
  failedRounds = 0;
  currentRun = null;
  runAgain = false;
  storage = null;
}

/** Test hook: the current entries. */
export function outboxEntriesForTests(): OutboxEntry[] {
  return [...entries.values()];
}
