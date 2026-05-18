import { useQuery } from "@tanstack/react-query";
/**
 * Shared hook for disk-synced editor content.
 * Handles React Query fetching, editor state machine,
 * nonce-based save orchestration, conflict resolution, content caching, and autosave.
 *
 * Each editor provides a deserialize/serialize pair and an optional content cache,
 * and handles its own imperative update mechanism (Monaco setValue, Crepe action, Excalidraw updateScene).
 */
import type { MutableRefObject } from "react";
import { useCallback, useEffect, useMemo, useRef } from "react";

import * as api from "@/api/client";
import { usePanelWorktreePath } from "@/components/dockview/panel-context";
import { type SaveOptions, saveEditorContent } from "@/lib/save-editor-content";
import { queryKeys } from "@/queries/query-keys";
import { useQueryScope } from "@/queries/use-scope";
import { type EditorFileState, useEditorStateStore } from "@/store/editor-state";

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
  /** Cache key (absolute file path). */
  cacheKey: string;
  /** Whether the active query errored. */
  isError: boolean;
  /** Ref the editor must populate with a fn returning current serialized content for save. */
  getSerializedContentRef: MutableRefObject<(() => string | null) | null>;
  /** Trigger a save. Uses getSerializedContentRef to read current content. Includes saveOptionsRef. */
  save: () => Promise<void>;
  /** Save immediately and clear any pending auto-save timers. Use for explicit Cmd+S. */
  saveNow: () => Promise<void>;
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

  // --- Scope ---
  const { activeProjectPath } = useQueryScope();
  const panelWorktreePath = usePanelWorktreePath();

  // Absolute file path IS the cache key — no scoping needed
  const cacheKey = filePath;

  // --- Refs for stable closures ---
  // Declared before the scope-change flush so the flush can read old values,
  // then updated to current values afterward.
  const filePathRef = useRef(filePath);
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
    if (fn) {
      const content = fn();
      if (content !== null) {
        saveEditorContent(filePathRef.current, content, worktreePathRef.current);
      }
    }
  }

  // Now update refs to current values
  filePathRef.current = filePath;
  cacheKeyRef.current = cacheKey;
  worktreePathRef.current = panelWorktreePath;
  deserializeRef.current = deserialize;
  contentCacheRef.current = contentCache;

  // --- Editor state ---
  const editorFileState = useEditorStateStore((s) => s.files.get(filePath)?.state ?? "clean");

  // --- File registration ---
  useEffect(() => {
    useEditorStateStore.getState().openFile(filePath);
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
        if (fn) {
          const content = fn();
          if (content !== null) {
            saveEditorContent(filePath, content, worktreePathRef.current, saveOptionsRef.current);
          }
        }
      }
      useEditorStateStore.getState().closeFile(filePath);
      contentCache?.delete(cacheKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filePath, cacheKey]);

  // --- Merge callbacks registration ---
  useEffect(() => {
    if (!mergeCallbacks) return;
    const { getContent, applyContent } = mergeCallbacks;
    useEditorStateStore.getState().registerEditorCallbacks(filePath, getContent, applyContent);
    return () => useEditorStateStore.getState().unregisterEditorCallbacks(filePath);
  }, [filePath, mergeCallbacks]);

  // --- Query ---
  const { data, isError } = useQuery({
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
  });

  // --- Set base content when data is available and state is clean ---
  useEffect(() => {
    if (data && editorFileState === "clean") {
      useEditorStateStore.getState().setBaseContent(filePath, data.content);
    }
  }, [data, filePath, editorFileState]);

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
    const fn = getSerializedContentRef.current;
    if (!fn) return;
    const content = fn();
    if (content === null) return;
    await saveEditorContent(
      filePathRef.current,
      content,
      worktreePathRef.current,
      autoSaveOptionsRef.current,
    );
  }, []);

  /** Explicit save: clears auto-save timers, uses saveOptionsRef (always formats if enabled). */
  const saveNow = useCallback(async () => {
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
    );
  }, []);

  // --- Conflict resolution ---
  const handleAcceptDisk = useCallback((): T | null => {
    const store = useEditorStateStore.getState();
    const entry = store.files.get(filePath);
    if (!entry?.diskContent) return null;
    let parsed: T | null = null;
    try {
      parsed = deserializeRef.current(entry.diskContent);
      contentCacheRef.current?.set(cacheKey, parsed);
    } catch {
      // Parse failed — still accept state-wise
    }
    store.acceptDiskVersion(filePath);
    return parsed;
  }, [filePath, cacheKey]);

  const handleKeepMine = useCallback(() => {
    useEditorStateStore.getState().keepMyChanges(filePath);
    if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current);
    if (autosaveCapTimerRef.current) clearTimeout(autosaveCapTimerRef.current);
    autosaveCapTimerRef.current = null;
    autosaveTimerRef.current = setTimeout(() => save(), AUTOSAVE_DEBOUNCE_MS);
  }, [filePath, save]);

  // --- Change handler (capped debounce: 250ms idle / 5s max wait) ---
  const handleChange = useCallback(
    (value: T) => {
      contentCacheRef.current?.set(cacheKeyRef.current, value);
      useEditorStateStore.getState().markDirty(filePathRef.current);
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
    cacheKey,
    isError,
    getSerializedContentRef,
    save,
    saveNow,
    saveOptionsRef,
    autoSaveOptionsRef,
    handleAcceptDisk,
    handleKeepMine,
    handleChange,
    isProgrammaticRef,
    autosaveTimerRef,
  };
}
