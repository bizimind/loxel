import * as api from "@/api/client";
import {
  type ServerId,
  type WorktreeRef,
  type WorktreeRefKey,
  formatWorktreeRef,
} from "@/api/worktree-ref";
import { showToast } from "@/components/ui/toast";
import type { FormattingSettings } from "@/lib/formatting-model";
import { frontendLog } from "@/lib/frontend-logger";
import {
  addOutboxEntry,
  ensureRetryScheduled,
  hasQueuedSave,
  outboxSaveFailed,
  outboxSaveWritten,
} from "@/lib/save-outbox";
import { diskBase, type EditorKey, useEditorStateStore } from "@/store/editor-state";

/**
 * Shared save orchestration for file-backed editors.
 * Handles nonce generation and state machine transitions.
 * The saving→clean transition is driven by the WebSocket file_content_changed echo
 * (nonce-matched in handleDiskChange), not the HTTP response.
 *
 * Both client and server track multiple nonces per file, so overlapping saves
 * (when the user types between saves) are handled correctly without losing nonces.
 */

// -- Worktrees held for saves --
// A worktree stays subscribed while a save for it is in flight, or waits in the save outbox, so
// the server still serves it when the save goes out: unsubscribing waits for them to drain.

const heldSaves = new Map<WorktreeRefKey, number>();
const drainCallbacks = new Map<WorktreeRefKey, () => void>();

/** Register a callback to fire once no save holds `wt` (at once if none does). */
export function onWorktreeSavesDrained(wt: WorktreeRef, callback: () => void): void {
  const key = formatWorktreeRef(wt);
  const count = heldSaves.get(key) ?? 0;
  if (count === 0) {
    callback();
  } else {
    drainCallbacks.set(key, callback);
  }
}

/** A save for `wt` is in flight or waiting: keep it subscribed until released. */
export function holdWorktree(wt: WorktreeRef): void {
  const key = formatWorktreeRef(wt);
  heldSaves.set(key, (heldSaves.get(key) ?? 0) + 1);
}

export function releaseWorktree(wt: WorktreeRef): void {
  const key = formatWorktreeRef(wt);
  const count = (heldSaves.get(key) ?? 1) - 1;
  if (count <= 0) {
    heldSaves.delete(key);
    const cb = drainCallbacks.get(key);
    if (cb) {
      drainCallbacks.delete(key);
      cb();
    }
  } else {
    heldSaves.set(key, count);
  }
}

/**
 * Why an editor's content is being written: `explicit` for Cmd+S (and re-creating a deleted file),
 * `auto` for autosave and for flushing unsaved edits (unmount, a move carrying them over).
 */
export type SaveReason = "auto" | "explicit";

export interface SaveOptions {
  format?: boolean;
  formattingSettings?: FormattingSettings;
}

/**
 * Content returned by the file-write response, keyed by nonce, with the editor that saved it.
 * When the WS echo arrives, the client can use this instead of fetching.
 * Entries auto-expire after 2 seconds to handle duplicate FS events
 * (the same nonce may appear in multiple file_content_changed messages).
 */
const savedContentByNonce = new Map<string, { content: string; editorKey: EditorKey }>();

const STASH_EXPIRY_MS = 2_000;

/**
 * Retrieve stashed content for a nonce saved by `editorKey` (kept alive for duplicate FS events).
 * Other editors of the same file get nothing: the content may already be outdated by a later save
 * of the saving editor, which only that editor can tell, so they read the file instead.
 */
export function consumeSavedContent(nonce: string, editorKey: EditorKey): string | undefined {
  const saved = savedContentByNonce.get(nonce);
  return saved?.editorKey === editorKey ? saved.content : undefined;
}

/**
 * Format notices already shown this session. A missing formatter would otherwise toast on every
 * save (and autosave) until the user installs it.
 */
const shownFormatNotices = new Set<string>();

function showFormatNotice(notice: string): void {
  if (shownFormatNotices.has(notice)) return;
  shownFormatNotices.add(notice);
  showToast(notice, "info");
}

function stashContent(nonce: string, content: string, editorKey: EditorKey): void {
  savedContentByNonce.set(nonce, { content, editorKey });
  setTimeout(() => savedContentByNonce.delete(nonce), STASH_EXPIRY_MS);
}

/**
 * Write editor content to `filePath` on `server` with a fresh nonce. Resolves to whether the server accepted the write;
 * completion of the save is still the nonce echo. Callers that keep the content elsewhere on
 * failure (e.g. a move carrying edits) use the result; others can ignore it.
 *
 * `editorKey` names the editor-state entry that tracks the save: the file's tab key
 * (`fileEditorKey`), or another view's (see `useEditorStateStore`). A save of an open editor
 * goes through the save outbox ([save-outbox.ts](save-outbox.ts)), which keeps it until the
 * server confirms it and retries it if the server cannot be reached. While an editor has a save
 * waiting there, its later saves wait too: the outbox reads the disk before writing, so edits
 * made on disk meanwhile are merged rather than overwritten.
 */
export async function saveEditorContent(
  server: ServerId,
  filePath: string,
  content: string,
  worktree: WorktreeRef | null | undefined,
  options: SaveOptions | undefined,
  editorKey: EditorKey,
): Promise<boolean> {
  const editor = useEditorStateStore.getState().files.get(editorKey);
  if (editor && hasQueuedSave(editor)) {
    addOutboxEntry(
      editor,
      {
        editorKey,
        server: editor.server,
        filePath,
        worktreePath: worktree?.path ?? null,
        base: diskBase(editor),
        content,
        options,
      },
      "queued",
    );
    ensureRetryScheduled();
    return false;
  }
  return writeEditorContent(server, filePath, content, worktree, options, editorKey);
}

/** `saveEditorContent` without waiting for the outbox: the disk is known to hold the base. */
export async function writeEditorContent(
  server: ServerId,
  filePath: string,
  content: string,
  worktree: WorktreeRef | null | undefined,
  options: SaveOptions | undefined,
  editorKey: EditorKey,
): Promise<boolean> {
  const result = await postEditorContent(server, filePath, content, worktree, options, editorKey);
  return result.ok;
}

/**
 * `writeEditorContent`, saying why it failed. With `expectedContent`, the server writes only if
 * the file still holds that (a retried save merged onto what it read).
 */
export async function postEditorContent(
  server: ServerId,
  filePath: string,
  content: string,
  worktree: WorktreeRef | null | undefined,
  options: SaveOptions | undefined,
  editorKey: EditorKey,
  expectedContent?: string,
): Promise<{ ok: true } | { ok: false; error: unknown }> {
  const nonce = crypto.randomUUID();
  const worktreePath = worktree?.path;
  const store = useEditorStateStore.getState();
  // A write with no editor behind it (a move carrying edits to a path with no tab yet) is not
  // kept: its caller keeps the edits if it fails.
  const editor = store.files.get(editorKey);
  const outbox = editor
    ? addOutboxEntry(
        editor,
        {
          editorKey,
          server: editor.server,
          filePath,
          worktreePath: worktreePath ?? null,
          base: diskBase(editor),
          content,
          options,
        },
        "sending",
      )
    : null;
  store.markSaving(editorKey, nonce);
  if (worktree) holdWorktree(worktree);
  try {
    // Stored before it is sent, so a reload or a crash while it is in flight keeps it.
    await outbox?.stored;
    const result = await api.writeFileContent(server, {
      path: filePath,
      content,
      nonce,
      worktree: worktree ?? undefined,
      format: options?.format,
      formattingSettings: options?.formattingSettings,
      expectedContent,
    });
    const written = result.content ?? content;
    useEditorStateStore.getState().markWritten(editorKey, nonce, written);
    if (outbox) outboxSaveWritten(outbox.entry, written);
    // Stash the written content (may be formatted) so the WS echo handler
    // can use it directly instead of fetching via HTTP.
    if (result.content !== undefined) {
      stashContent(nonce, result.content, editorKey);
    }
    if (result.formatNotice) showFormatNotice(result.formatNotice);
    // State transition is handled by the WebSocket file_content_changed echo
    // (matched by nonce in handleDiskChange). Safety timeout ensures we don't
    // stay stuck if the echo is lost (watcher miss, WS disconnect).
    setTimeout(() => {
      const entry = useEditorStateStore.getState().files.get(editorKey);
      if (entry && entry.pendingNonces.has(nonce)) {
        frontendLog
          .child("files")
          .warn("Save echo timeout — nonce not confirmed, resetting to dirty", { filePath });
        useEditorStateStore.getState().handleSaveError(editorKey, nonce);
      }
    }, 10_000);
    return { ok: true };
  } catch (err) {
    frontendLog
      .child("files")
      .error("Failed to save file", { filePath, error: err instanceof Error ? err : undefined });
    useEditorStateStore.getState().handleSaveError(editorKey, nonce);
    if (outbox) outboxSaveFailed(outbox.entry, err);
    return { ok: false, error: err };
  } finally {
    if (worktree) releaseWorktree(worktree);
  }
}
