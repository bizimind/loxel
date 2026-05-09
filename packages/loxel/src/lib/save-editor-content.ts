import type { FormattingSettings } from "@/lib/formatting-model";

import * as api from "@/api/client";
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
 * Content returned by the file-write response, keyed by nonce.
 * When the WS echo arrives, the client can use this instead of fetching.
 * Entries auto-expire after 2 seconds to handle duplicate FS events
 * (the same nonce may appear in multiple file_content_changed messages).
 */
const savedContentByNonce = new Map<string, string>();

const STASH_EXPIRY_MS = 2_000;

/** Retrieve stashed content for a nonce (kept alive for duplicate FS events). */
export function consumeSavedContent(nonce: string): string | undefined {
  return savedContentByNonce.get(nonce);
}

function stashContent(nonce: string, content: string): void {
  savedContentByNonce.set(nonce, content);
  setTimeout(() => savedContentByNonce.delete(nonce), STASH_EXPIRY_MS);
}

export async function saveEditorContent(
  filePath: string,
  content: string,
  worktreePath?: string | null,
  options?: SaveOptions,
): Promise<void> {
  const nonce = crypto.randomUUID();
  const wtKey = worktreePath ?? "";
  useEditorStateStore.getState().markSaving(filePath, nonce);
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
      stashContent(nonce, result.content);
    }
    // State transition is handled by the WebSocket file_content_changed echo
    // (matched by nonce in handleDiskChange). Safety timeout ensures we don't
    // stay stuck if the echo is lost (watcher miss, WS disconnect).
    setTimeout(() => {
      const entry = useEditorStateStore.getState().files.get(filePath);
      if (entry && entry.pendingNonces.has(nonce)) {
        frontendLog
          .child("files")
          .warn("Save echo timeout — nonce not confirmed, resetting to dirty", { filePath });
        useEditorStateStore.getState().handleSaveError(filePath, nonce);
      }
    }, 10_000);
  } catch (err) {
    frontendLog
      .child("files")
      .error("Failed to save file", { filePath, error: err instanceof Error ? err : undefined });
    useEditorStateStore.getState().handleSaveError(filePath, nonce);
  } finally {
    if (wtKey) decrementPending(wtKey);
  }
}
