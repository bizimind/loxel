import * as api from "@/api/client";
import type { FormattingSettings } from "@/lib/formatting-model";
import { frontendLog } from "@/lib/frontend-logger";
import { useEditorStateStore } from "@/store/editor-state";

/**
 * Shared save orchestration for file-backed editors.
 * Handles nonce generation and state machine transitions.
 * The saving→clean transition is driven by the WebSocket file_content_changed echo
 * (nonce-matched in handleDiskChange), not the HTTP response.
 *
 * Both client and server track multiple nonces per file, so overlapping saves
 * (when the user types between saves) are handled correctly without losing nonces.
 */

// -- Pending save tracking per worktree --
// Used to defer WS unsubscribe until all saves for a worktree complete.

const pendingSaves = new Map<string, number>();
const drainCallbacks = new Map<string, () => void>();

/** Register a callback to fire when all pending saves for a worktree complete. */
export function onWorktreeSavesDrained(worktreePath: string, callback: () => void): void {
  const count = pendingSaves.get(worktreePath) ?? 0;
  if (count === 0) {
    callback();
  } else {
    drainCallbacks.set(worktreePath, callback);
  }
}

function incrementPending(worktreePath: string): void {
  pendingSaves.set(worktreePath, (pendingSaves.get(worktreePath) ?? 0) + 1);
}

function decrementPending(worktreePath: string): void {
  const count = (pendingSaves.get(worktreePath) ?? 1) - 1;
  if (count <= 0) {
    pendingSaves.delete(worktreePath);
    const cb = drainCallbacks.get(worktreePath);
    if (cb) {
      drainCallbacks.delete(worktreePath);
      cb();
    }
  } else {
    pendingSaves.set(worktreePath, count);
  }
}

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
const savedContentByNonce = new Map<string, { content: string; editorKey: string }>();

const STASH_EXPIRY_MS = 2_000;

/**
 * Retrieve stashed content for a nonce saved by `editorKey` (kept alive for duplicate FS events).
 * Other editors of the same file get nothing: the content may already be outdated by a later save
 * of the saving editor, which only that editor can tell, so they read the file instead.
 */
export function consumeSavedContent(nonce: string, editorKey: string): string | undefined {
  const saved = savedContentByNonce.get(nonce);
  return saved?.editorKey === editorKey ? saved.content : undefined;
}

function stashContent(nonce: string, content: string, editorKey: string): void {
  savedContentByNonce.set(nonce, { content, editorKey });
  setTimeout(() => savedContentByNonce.delete(nonce), STASH_EXPIRY_MS);
}

/**
 * Write editor content with a fresh nonce. Resolves to whether the server accepted the write;
 * completion of the save is still the nonce echo. Callers that keep the content elsewhere on
 * failure (e.g. a move carrying edits) use the result; others can ignore it.
 *
 * `editorKey` names the editor-state entry that tracks the save; it is the file path except for
 * editors that are not the file's own tab (see `useEditorStateStore`).
 */
export async function saveEditorContent(
  filePath: string,
  content: string,
  worktreePath?: string | null,
  options?: SaveOptions,
  editorKey: string = filePath,
): Promise<boolean> {
  const nonce = crypto.randomUUID();
  const wtKey = worktreePath ?? "";
  useEditorStateStore.getState().markSaving(editorKey, nonce);
  if (wtKey) incrementPending(wtKey);
  try {
    const result = await api.writeFileContent({
      path: filePath,
      content,
      nonce,
      worktreePath: worktreePath ?? undefined,
      format: options?.format,
      formattingSettings: options?.formattingSettings,
    });
    // Stash the written content (may be formatted) so the WS echo handler
    // can use it directly instead of fetching via HTTP.
    if (result.content !== undefined) {
      stashContent(nonce, result.content, editorKey);
    }
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
    return true;
  } catch (err) {
    frontendLog
      .child("files")
      .error("Failed to save file", { filePath, error: err instanceof Error ? err : undefined });
    useEditorStateStore.getState().handleSaveError(editorKey, nonce);
    return false;
  } finally {
    if (wtKey) decrementPending(wtKey);
  }
}
