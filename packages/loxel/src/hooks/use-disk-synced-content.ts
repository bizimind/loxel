/**
 * Shared hook for disk-synced editor content.
 * Handles React Query fetching, editor state machine,
 * nonce-based save orchestration, conflict resolution, content caching, and autosave.
 *
 * Each editor provides a deserialize/serialize pair and an optional content cache,
 * and handles its own imperative update mechanism (Monaco setValue, Crepe action, Excalidraw updateScene).
 */

import { useQuery } from "@tanstack/react-query";
import type { MutableRefObject } from "react";
import { useCallback, useEffect, useMemo, useRef } from "react";

import * as api from "@/api/client";
import { usePanelWorktreePath } from "@/components/dockview/panel-context";
import { requestConfirmation } from "@/components/ui/confirm-dialog-host";
import { getDisplayFilename } from "@/lib/detached-path";
import { type SaveOptions, saveEditorContent } from "@/lib/save-editor-content";
import { queryKeys } from "@/queries/query-keys";
import { useQueryScope } from "@/queries/use-scope";
import { type EditorFileState, useEditorStateStore } from "@/store/editor-state";
import { useSettingsStore } from "@/store/settings-store";

export const AUTOSAVE_DEBOUNCE_MS = 250;
export const AUTOSAVE_MAX_WAIT_MS = 5_000;

export interface MergeCallbacks {
  /** Returns current editor content as serialized string. */
  getContent: () => string | null;
  /**
   * Imperatively applies merged content to the editor.
   * Returns canonicalized content (may differ from input due to editor normalization),
   * or null on failure.
   * @param programmatic When true, the edit is programmatic (e.g. format-echo) and should
   * not trigger auto-save.
   */
  applyContent: (merged: string, programmatic: boolean) => string | null;
}

export interface UseDiskSyncedContentOptions<T> {
  filePath: string;
  /**
   * Editor-state key for this editor. Defaults to `filePath`, which is right for a file's own tab;
   * other views of a file (a compare panel side) pass a key of their own so they get their own
   * state entry.
   */
  editorKey?: string;
  /** Parse raw file content string into typed content T. */
  deserialize: (raw: string) => T;
  /** External content cache (Map<cacheKey, T>). null = no cache (e.g. CodeEditor). */
  contentCache: Map<string, T> | null;
  /** Merge callbacks for 3-way auto-merge. null = no merge support (e.g. Excalidraw). */
  mergeCallbacks?: MergeCallbacks | null;
}

export interface DiskSyncedContent<T> {
  /** Parsed disk content. Changes when query refetches. Falls back to cache while loading. */
  diskContent: T | null;
  /** Current file state from the editor state machine. */
  editorFileState: EditorFileState;
  /** The file no longer exists on disk. Autosave is suspended; see `saveNow` / `recreateFile`. */
  isDeleted: boolean;
  /** Cache key (absolute file path). */
  cacheKey: string;
  /** Whether the active query errored. */
  isError: boolean;
  /** Ref the editor must populate with a fn returning current serialized content for save. */
  getSerializedContentRef: MutableRefObject<(() => string | null) | null>;
  /** Trigger a save. Uses getSerializedContentRef to read current content. Includes saveOptionsRef. */
  save: () => Promise<void>;
  /**
   * Save immediately and clear any pending auto-save timers. Use for explicit Cmd+S.
   * When the file was deleted from disk, asks the user to confirm re-creating it first.
   */
  saveNow: () => Promise<void>;
  /** Write a deleted file back to disk without asking (the user already clicked "Re-create"). */
  recreateFile: () => Promise<void>;
  /**
   * Ref for save options on explicit saves (Cmd+S, flush on worktree switch).
   * Set by editors that support format-on-save to include formatting settings.
   */
  saveOptionsRef: MutableRefObject<SaveOptions | undefined>;
  /**
   * Ref for save options on auto-saves (debounced from user typing).
   * Set by editors that support format-on-auto-save.
   */
  autoSaveOptionsRef: MutableRefObject<SaveOptions | undefined>;
  /** Accept disk version. Returns parsed T for the editor to apply. Updates cache + store. */
  handleAcceptDisk: () => T | null;
  /** Keep editor's changes. Re-arms autosave. */
  handleKeepMine: () => void;
  /** Call on user edit. Updates cache + markDirty + debounce autosave. */
  handleChange: (value: T) => void;
  /** Guard ref — editor sets true during programmatic updates to suppress handleChange. */
  isProgrammaticRef: MutableRefObject<boolean>;
  /** Autosave timer ref — exposed for edge cases (e.g. Crepe cleanup snapshot). */
  autosaveTimerRef: MutableRefObject<ReturnType<typeof setTimeout> | null>;
}

export function useDiskSyncedContent<T>(
  options: UseDiskSyncedContentOptions<T>,
): DiskSyncedContent<T> {
  const { filePath, deserialize, contentCache, mergeCallbacks } = options;
  const editorKey = options.editorKey ?? filePath;

  // --- Scope ---
  const { activeProjectPath } = useQueryScope();
  const panelWorktreePath = usePanelWorktreePath();

  // Absolute file path IS the cache key — no scoping needed
  const cacheKey = filePath;

  // --- Refs for stable closures ---
  // Declared before the scope-change flush so the flush can read old values,
  // then updated to current values afterward.
  const filePathRef = useRef(filePath);
  const editorKeyRef = useRef(editorKey);
  const cacheKeyRef = useRef(cacheKey);
  const worktreePathRef = useRef(panelWorktreePath);
  const deserializeRef = useRef(deserialize);
  const contentCacheRef = useRef(contentCache);

  const isProgrammaticRef = useRef(false);
  const autosaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const autosaveCapTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const getSerializedContentRef = useRef<(() => string | null) | null>(null);

  // --- Flush pending save on scope change ---
  // With absolute paths, cacheKey only changes if filePath changes (e.g. file rename).
  // The panel is destroyed/recreated on worktree switch, so this is a safety net.
  if (cacheKeyRef.current !== cacheKey && autosaveTimerRef.current) {
    clearTimeout(autosaveTimerRef.current);
    autosaveTimerRef.current = null;
    if (autosaveCapTimerRef.current) {
      clearTimeout(autosaveCapTimerRef.current);
      autosaveCapTimerRef.current = null;
    }
    const fn = getSerializedContentRef.current;
    if (fn && !isFileDeleted(editorKeyRef.current)) {
      const content = fn();
      if (content !== null) {
        saveEditorContent(
          filePathRef.current,
          content,
          worktreePathRef.current,
          undefined,
          editorKeyRef.current,
        );
      }
    }
  }

  // Now update refs to current values
  filePathRef.current = filePath;
  editorKeyRef.current = editorKey;
  cacheKeyRef.current = cacheKey;
  worktreePathRef.current = panelWorktreePath;
  deserializeRef.current = deserialize;
  contentCacheRef.current = contentCache;

  // --- Editor state ---
  const editorFileState = useEditorStateStore((s) => s.files.get(editorKey)?.state ?? "clean");
  const isDeleted = useEditorStateStore((s) => s.files.get(editorKey)?.deleted ?? false);

  // --- File registration ---
  useEffect(() => {
    useEditorStateStore.getState().openFile(editorKey, filePath);
    return () => {
      // Flush pending save before closing — handles unmount.
      // On scope change, the render-phase flush above already clears the timer,
      // so this is a no-op in that case.
      if (autosaveTimerRef.current) {
        clearTimeout(autosaveTimerRef.current);
        autosaveTimerRef.current = null;
        if (autosaveCapTimerRef.current) {
          clearTimeout(autosaveCapTimerRef.current);
          autosaveCapTimerRef.current = null;
        }
        const fn = getSerializedContentRef.current;
        const target = flushTarget(editorKey);
        if (fn && target) {
          const content = fn();
          if (content !== null) {
            // A moved file's flush goes to its new path, whose tab is keyed by that path.
            const key = target === filePath ? editorKey : target;
            saveEditorContent(
              target,
              content,
              worktreePathRef.current,
              saveOptionsRef.current,
              key,
            );
          }
        }
      }
      useEditorStateStore.getState().closeFile(editorKey);
      contentCache?.delete(cacheKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filePath, editorKey, cacheKey]);

  // --- Unsaved edits, taken over by a move ---
  useEffect(() => {
    const take = () => {
      // Decided by state, not only by a pending timer: an editor can be dirty with no timer
      // (edits made while the file was missing never armed a save that wrote anything).
      const state = useEditorStateStore.getState().files.get(editorKey)?.state;
      const unsaved = autosaveTimerRef.current !== null || state === "dirty" || state === "saving";
      if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current);
      if (autosaveCapTimerRef.current) clearTimeout(autosaveCapTimerRef.current);
      autosaveTimerRef.current = null;
      autosaveCapTimerRef.current = null;
      if (!unsaved) return null;
      const content = getSerializedContentRef.current?.() ?? null;
      return content === null ? null : { content, options: saveOptionsRef.current };
    };
    useEditorStateStore.getState().registerPendingEdit(editorKey, take);
    return () => useEditorStateStore.getState().registerPendingEdit(editorKey, null);
  }, [editorKey]);

  // --- Merge callbacks registration ---
  useEffect(() => {
    if (!mergeCallbacks) return;
    const { getContent, applyContent } = mergeCallbacks;
    useEditorStateStore.getState().registerEditorCallbacks(editorKey, getContent, applyContent);
    return () => useEditorStateStore.getState().unregisterEditorCallbacks(editorKey);
  }, [editorKey, mergeCallbacks]);

  // --- Query ---
  const { data, dataUpdatedAt, isError, error } = useQuery({
    queryKey: queryKeys.fileContent(
      activeProjectPath,
      filePath,
      undefined,
      panelWorktreePath ?? undefined,
    ),
    queryFn: ({ signal }) => api.getFileContentByPath(filePath, panelWorktreePath, signal),
    // Force a background refetch on every mount so editors pick up external changes
    // that occurred while the worktree was unsubscribed (e.g. switched to another tab).
    // With staleTime: Infinity, the default `true` never refetches — "always" overrides that.
    refetchOnMount: "always",
    // A confirmed-missing file will not appear by retrying; anything else (including a 404 for a
    // worktree the server has not finished subscribing) keeps the default single retry.
    retry: (failureCount, err) => !api.isFileMissingError(err) && failureCount < 1,
  });

  // --- Existence tracking ---
  // Clean editors usually learn about a deletion through this query: the change event
  // invalidates it and the refetch returns 404 (`data` keeps the last content). The WebSocket
  // bridge also sets the flag itself (dirty editors, parent-directory events). Any successful
  // fetch clears it: keyed on `dataUpdatedAt`, because a restore with identical content keeps
  // the same `data` object (structural sharing) and would otherwise change nothing here.
  const isMissingOnDisk = isError && api.isFileMissingError(error);
  useEffect(() => {
    if (isMissingOnDisk) useEditorStateStore.getState().setDeleted(editorKey, true);
    else if (dataUpdatedAt > 0) useEditorStateStore.getState().setDeleted(editorKey, false);
  }, [isMissingOnDisk, dataUpdatedAt, editorKey]);

  // --- Set base content when data is available and state is clean ---
  useEffect(() => {
    if (data && editorFileState === "clean") {
      useEditorStateStore.getState().setBaseContent(editorKey, data.content);
    }
  }, [data, editorKey, editorFileState]);

  // --- Content derivation ---
  const diskContent = useMemo<T | null>(() => {
    if (!data) return contentCache?.get(cacheKey) ?? null;
    try {
      return deserialize(data.content);
    } catch {
      return null;
    }
  }, [data, cacheKey, deserialize, contentCache]);

  // --- Save ---
  const saveOptionsRef = useRef<SaveOptions | undefined>(undefined);
  const autoSaveOptionsRef = useRef<SaveOptions | undefined>(undefined);

  /** Auto-save: uses autoSaveOptionsRef (format only if formatOnAutoSave is enabled). */
  const save = useCallback(async () => {
    // Never re-create a deleted file implicitly (only an explicit, confirmed save may), and
    // never write to the old path of a file that is being moved.
    if (isFileDeleted(editorKeyRef.current) || isFileMoving(editorKeyRef.current)) return;
    const fn = getSerializedContentRef.current;
    if (!fn) return;
    const content = fn();
    if (content === null) return;
    await saveEditorContent(
      filePathRef.current,
      content,
      worktreePathRef.current,
      autoSaveOptionsRef.current,
      editorKeyRef.current,
    );
  }, []);

  /**
   * Explicit write: clears auto-save timers, uses saveOptionsRef (always formats if enabled).
   * Does not check `deleted`, so it is also what re-creates a deleted file.
   */
  const writeNow = useCallback(async () => {
    if (autosaveTimerRef.current) {
      clearTimeout(autosaveTimerRef.current);
      autosaveTimerRef.current = null;
    }
    if (autosaveCapTimerRef.current) {
      clearTimeout(autosaveCapTimerRef.current);
      autosaveCapTimerRef.current = null;
    }
    const fn = getSerializedContentRef.current;
    if (!fn) return;
    const content = fn();
    if (content === null) return;
    await saveEditorContent(
      filePathRef.current,
      content,
      worktreePathRef.current,
      saveOptionsRef.current,
      editorKeyRef.current,
    );
  }, []);

  const saveNow = useCallback(async () => {
    const path = filePathRef.current;
    const key = editorKeyRef.current;
    if (isFileDeleted(key)) {
      const confirmed = await requestConfirmation({
        title: "Re-create deleted file?",
        description: `"${getDisplayFilename(path)}" was removed from disk. Saving will create it again with the editor's current content.`,
        confirmLabel: "Re-create",
      });
      if (!confirmed || key !== editorKeyRef.current) return;
      // The file may have come back while the dialog was open. If that restore conflicted with
      // the editor, let the conflict banner decide instead of overwriting the restored content.
      const entry = useEditorStateStore.getState().files.get(key);
      if (!entry?.deleted && entry?.state === "diverged") return;
    }
    await writeNow();
  }, [writeNow]);

  // --- Resume autosave once a deleted file exists again ---
  // Edits made while the file was gone were never written. If the restore merged cleanly with
  // the editor still dirty, nothing re-arms the timers, so do it here.
  const wasDeletedRef = useRef(false);
  useEffect(() => {
    const wasDeleted = wasDeletedRef.current;
    wasDeletedRef.current = isDeleted;
    if (!wasDeleted || isDeleted) return;
    if (useEditorStateStore.getState().files.get(editorKey)?.state !== "dirty") return;
    if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current);
    autosaveTimerRef.current = setTimeout(() => {
      autosaveTimerRef.current = null;
      save();
    }, AUTOSAVE_DEBOUNCE_MS);
  }, [isDeleted, editorKey, save]);

  // --- Conflict resolution ---
  const handleAcceptDisk = useCallback((): T | null => {
    const store = useEditorStateStore.getState();
    const entry = store.files.get(editorKey);
    if (!entry?.diskContent) return null;
    let parsed: T | null = null;
    try {
      parsed = deserializeRef.current(entry.diskContent);
      contentCacheRef.current?.set(cacheKey, parsed);
    } catch {
      // Parse failed — still accept state-wise
    }
    store.acceptDiskVersion(editorKey);
    return parsed;
  }, [editorKey, cacheKey]);

  const handleKeepMine = useCallback(() => {
    useEditorStateStore.getState().keepMyChanges(editorKey);
    if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current);
    if (autosaveCapTimerRef.current) clearTimeout(autosaveCapTimerRef.current);
    autosaveCapTimerRef.current = null;
    autosaveTimerRef.current = setTimeout(() => save(), AUTOSAVE_DEBOUNCE_MS);
  }, [editorKey, save]);

  // --- Change handler (capped debounce: 250ms idle / 5s max wait) ---
  const handleChange = useCallback(
    (value: T) => {
      contentCacheRef.current?.set(cacheKeyRef.current, value);
      useEditorStateStore.getState().markDirty(editorKeyRef.current);
      // Reset the idle debounce on every keystroke
      if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current);
      autosaveTimerRef.current = setTimeout(() => {
        autosaveTimerRef.current = null;
        if (autosaveCapTimerRef.current) {
          clearTimeout(autosaveCapTimerRef.current);
          autosaveCapTimerRef.current = null;
        }
        save();
      }, AUTOSAVE_DEBOUNCE_MS);
      // Start the max-wait cap timer on the first keystroke of a burst
      if (!autosaveCapTimerRef.current) {
        autosaveCapTimerRef.current = setTimeout(() => {
          autosaveCapTimerRef.current = null;
          if (autosaveTimerRef.current) {
            clearTimeout(autosaveTimerRef.current);
            autosaveTimerRef.current = null;
          }
          save();
        }, AUTOSAVE_MAX_WAIT_MS);
      }
    },
    [save],
  );

  // --- Timer cleanup ---
  // File registration cleanup above handles flush-on-unmount. This is a safety
  // net in case the timer is re-armed between file registration cleanup and
  // this unmount-only cleanup (shouldn't happen, but defensive).
  useEffect(() => {
    return () => {
      if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current);
      if (autosaveCapTimerRef.current) clearTimeout(autosaveCapTimerRef.current);
    };
  }, []);

  return {
    diskContent,
    editorFileState,
    isDeleted,
    cacheKey,
    isError,
    getSerializedContentRef,
    save,
    saveNow,
    recreateFile: writeNow,
    saveOptionsRef,
    autoSaveOptionsRef,
    handleAcceptDisk,
    handleKeepMine,
    handleChange,
    isProgrammaticRef,
    autosaveTimerRef,
  };
}

/**
 * Keep an editor's save options in sync with the formatting settings: explicit saves format when
 * formatting is on, autosaves only when format-on-autosave is on too.
 */
export function useFormatOnSave({
  saveOptionsRef,
  autoSaveOptionsRef,
}: Pick<DiskSyncedContent<unknown>, "saveOptionsRef" | "autoSaveOptionsRef">): void {
  const formattingSettings = useSettingsStore((s) => s.editor.formatting);
  saveOptionsRef.current = formattingSettings.enabled
    ? { format: true, formattingSettings }
    : undefined;
  autoSaveOptionsRef.current =
    formattingSettings.enabled && formattingSettings.formatOnAutoSave
      ? { format: true, formattingSettings }
      : undefined;
}

function isFileDeleted(editorKey: string): boolean {
  return useEditorStateStore.getState().files.get(editorKey)?.deleted ?? false;
}

function isFileMoving(editorKey: string): boolean {
  return Boolean(useEditorStateStore.getState().files.get(editorKey)?.movedTo);
}

/**
 * Where an unmounting editor writes its pending edit: the new path of a moved file, nothing for
 * a deleted file or one whose entry a delete or move handler already closed, else the file.
 */
function flushTarget(editorKey: string): string | null {
  const entry = useEditorStateStore.getState().files.get(editorKey);
  if (!entry) return null;
  if (entry.movedTo) return entry.movedTo;
  return entry.deleted ? null : entry.filePath;
}
