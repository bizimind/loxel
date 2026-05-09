import { create } from "zustand";

import { threeWayMerge } from "../lib/three-way-merge";

export type EditorFileState = "clean" | "dirty" | "saving" | "diverged";

export interface EditorFileEntry {
  state: EditorFileState;
  /** Nonces of in-flight save requests. Multiple saves can overlap when the user
   *  types between saves — each generates a new nonce, and the previous echo may
   *  arrive after the next save has already started. */
  pendingNonces: Set<string>;
  /** Latest disk content from external change — used for diverged resolution. */
  diskContent: string | null;
  /** Content at last clean state — used as merge base for 3-way auto-merge. */
  baseContent: string | null;
  /** Registered by text editors (CodeEditor, MarkdownEditor) for auto-merge.
   *  Returns current editor content as serialized string. null for Excalidraw / unmounted. */
  getEditorContent: (() => string | null) | null;
  /** Imperatively applies merged content to the editor DOM.
   *  Returns canonicalized content (may differ from input due to editor normalization),
   *  or null on failure.
   *  @param programmatic When true, the edit should be treated as programmatic (not a user edit)
   *  so it doesn't trigger auto-save. Used for format-echo merges where content is already on disk. */
  applyMergedContent: ((merged: string, programmatic: boolean) => string | null) | null;
  /** Editor content snapshot captured per-nonce at save-start.
   *  Used as the merge base for format-echo merges so formatting changes
   *  don't conflict with the user's own edits on the same lines.
   *  Per-nonce (not shared) so that delayed echoes from overlapping saves
   *  use the correct ancestor — not the latest save's snapshot. */
  savedSnapshots: Map<string, string>;
}

interface EditorStateStore {
  files: Map<string, EditorFileEntry>;

  openFile: (filePath: string) => void;
  closeFile: (filePath: string) => void;
  markDirty: (filePath: string) => void;
  markSaving: (filePath: string, nonce: string) => void;
  handleSaveError: (filePath: string, nonce: string) => void;
  /** Core state machine: handle an external disk change notification. */
  handleDiskChange: (filePath: string, nonces: string[], diskContent: string) => void;
  acceptDiskVersion: (filePath: string) => void;
  keepMyChanges: (filePath: string) => void;
  clearPendingNonce: (filePath: string, nonce: string) => void;
  /** Set the merge base content (called when state reaches clean). */
  setBaseContent: (filePath: string, content: string) => void;
  /** Register editor callbacks for 3-way auto-merge. */
  registerEditorCallbacks: (
    filePath: string,
    getContent: () => string | null,
    applyContent: (merged: string, programmatic: boolean) => string | null,
  ) => void;
  /** Unregister editor callbacks (on unmount). */
  unregisterEditorCallbacks: (filePath: string) => void;
}

function defaultEntry(): EditorFileEntry {
  return {
    state: "clean",
    pendingNonces: new Set(),
    diskContent: null,
    baseContent: null,
    getEditorContent: null,
    applyMergedContent: null,
    savedSnapshots: new Map(),
  };
}

export const useEditorStateStore = create<EditorStateStore>()((set, get) => ({
  files: new Map(),

  openFile: (filePath) => {
    set((s) => {
      if (s.files.has(filePath)) return s;
      const files = new Map(s.files);
      files.set(filePath, defaultEntry());
      return { files };
    });
  },

  closeFile: (filePath) => {
    set((s) => {
      if (!s.files.has(filePath)) return s;
      const files = new Map(s.files);
      files.delete(filePath);
      return { files };
    });
  },

  markDirty: (filePath) => {
    set((s) => {
      const entry = s.files.get(filePath);
      if (!entry) return s;
      // Valid from any state — user typed
      if (entry.state === "dirty") return s;
      const files = new Map(s.files);
      files.set(filePath, { ...entry, state: "dirty" });
      return { files };
    });
  },

  markSaving: (filePath, nonce) => {
    // Snapshot editor content before entering set() (impure read)
    const currentEntry = get().files.get(filePath);
    const snapshot = currentEntry?.getEditorContent?.() ?? currentEntry?.baseContent ?? null;
    set((s) => {
      const entry = s.files.get(filePath);
      if (!entry) return s;
      const files = new Map(s.files);
      const pendingNonces = new Set(entry.pendingNonces);
      pendingNonces.add(nonce);
      const savedSnapshots = new Map(entry.savedSnapshots);
      if (snapshot !== null) savedSnapshots.set(nonce, snapshot);
      files.set(filePath, { ...entry, state: "saving", pendingNonces, savedSnapshots });
      return { files };
    });
  },

  handleSaveError: (filePath, nonce) => {
    set((s) => {
      const entry = s.files.get(filePath);
      if (!entry) return s;
      const files = new Map(s.files);
      const pendingNonces = new Set(entry.pendingNonces);
      pendingNonces.delete(nonce);
      const savedSnapshots = new Map(entry.savedSnapshots);
      savedSnapshots.delete(nonce);
      const nextState = pendingNonces.size > 0 ? "saving" : "dirty";
      files.set(filePath, { ...entry, state: nextState, pendingNonces, savedSnapshots });
      return { files };
    });
  },

  handleDiskChange: (filePath, nonces, diskContent) => {
    const entry = get().files.get(filePath);
    if (!entry) return;
    const matchedNonces = nonces.filter((n) => entry.pendingNonces.has(n));
    const isOwnEcho = matchedNonces.length > 0;

    // If an own-echo arrives for a nonce that has been superseded (newer saves
    // still in flight), the disk state implied by this echo is stale — a later
    // save has overwritten it. Merging would be wrong; drop the matched nonces
    // and let the latest save's echo reconcile.
    const superseded = isOwnEcho && entry.pendingNonces.size > matchedNonces.length;
    if (superseded) {
      set((s) => {
        const e = s.files.get(filePath);
        if (!e) return s;
        const files = new Map(s.files);
        const pending = new Set(e.pendingNonces);
        const snapshots = new Map(e.savedSnapshots);
        for (const n of matchedNonces) {
          pending.delete(n);
          snapshots.delete(n);
        }
        files.set(filePath, { ...e, pendingNonces: pending, savedSnapshots: snapshots });
        return { files };
      });
      return;
    }

    // Pick merge base: first matched nonce's snapshot (content at that save's start).
    const snapshotBase = matchedNonces
      .map((n) => entry.savedSnapshots.get(n))
      .find((v) => v !== undefined);

    switch (entry.state) {
      case "clean":
        // Caller handles updating editor content
        break;

      case "saving":
        if (isOwnEcho) {
          // Check if disk content differs from editor (e.g. server-side formatting).
          // If so, merge the formatted result into the editor using the content-at-save-time
          // as the merge base. This prevents formatting from conflicting with the user's
          // own edits (which were the basis for the formatting).
          const editorContent = entry.getEditorContent?.();
          if (
            editorContent &&
            editorContent !== diskContent &&
            !tryAutoMerge(entry, diskContent, filePath, set, {
              preferOurs: true,
              matchedNonces,
              mergeBase: snapshotBase,
            })
          ) {
            // Fallback: just transition to clean (merge shouldn't fail with preferOurs,
            // but be defensive)
            set((s) => {
              const e = s.files.get(filePath);
              if (!e || e.state !== "saving") return s;
              const files = new Map(s.files);
              const pending = new Set(e.pendingNonces);
              const snapshots = new Map(e.savedSnapshots);
              for (const n of matchedNonces) {
                pending.delete(n);
                snapshots.delete(n);
              }
              const nextState = pending.size === 0 ? "clean" : "saving";
              files.set(filePath, {
                ...e,
                state: nextState,
                pendingNonces: pending,
                savedSnapshots: snapshots,
                baseContent: diskContent,
                diskContent: null,
              });
              return { files };
            });
          } else if (!editorContent || editorContent === diskContent) {
            // Normal own echo — content matches, just transition to clean
            set((s) => {
              const e = s.files.get(filePath);
              if (!e || e.state !== "saving") return s;
              const files = new Map(s.files);
              const pending = new Set(e.pendingNonces);
              const snapshots = new Map(e.savedSnapshots);
              for (const n of matchedNonces) {
                pending.delete(n);
                snapshots.delete(n);
              }
              const nextState = pending.size === 0 ? "clean" : "saving";
              files.set(filePath, {
                ...e,
                state: nextState,
                pendingNonces: pending,
                savedSnapshots: snapshots,
                baseContent: diskContent,
                diskContent: null,
              });
              return { files };
            });
          }
        } else if (!tryAutoMerge(entry, diskContent, filePath, set)) {
          set((s) => {
            const e = s.files.get(filePath);
            if (!e) return s;
            const files = new Map(s.files);
            files.set(filePath, { ...e, state: "diverged", diskContent });
            return { files };
          });
        }
        break;

      case "dirty":
        if (isOwnEcho) {
          // Check if disk content differs from editor (e.g. server-side formatting).
          // If so, merge the formatted result using content-at-save-time as merge base.
          const dirtyEditorContent = entry.getEditorContent?.();
          if (
            dirtyEditorContent &&
            dirtyEditorContent !== diskContent &&
            !tryAutoMerge(entry, diskContent, filePath, set, {
              preferOurs: true,
              matchedNonces,
              mergeBase: snapshotBase,
            })
          ) {
            // Fallback: just update base and clear nonces
            set((s) => {
              const e = s.files.get(filePath);
              if (!e) return s;
              const files = new Map(s.files);
              const pending = new Set(e.pendingNonces);
              const snapshots = new Map(e.savedSnapshots);
              for (const n of matchedNonces) {
                pending.delete(n);
                snapshots.delete(n);
              }
              files.set(filePath, {
                ...e,
                baseContent: diskContent,
                pendingNonces: pending,
                savedSnapshots: snapshots,
              });
              return { files };
            });
          } else if (!dirtyEditorContent || dirtyEditorContent === diskContent) {
            // Content matches or editor unavailable — just update base and clear nonces
            set((s) => {
              const e = s.files.get(filePath);
              if (!e) return s;
              const files = new Map(s.files);
              const pending = new Set(e.pendingNonces);
              const snapshots = new Map(e.savedSnapshots);
              for (const n of matchedNonces) {
                pending.delete(n);
                snapshots.delete(n);
              }
              files.set(filePath, {
                ...e,
                baseContent: diskContent,
                pendingNonces: pending,
                savedSnapshots: snapshots,
              });
              return { files };
            });
          }
        } else if (!tryAutoMerge(entry, diskContent, filePath, set)) {
          set((s) => {
            const e = s.files.get(filePath);
            if (!e) return s;
            const files = new Map(s.files);
            files.set(filePath, { ...e, state: "diverged", diskContent });
            return { files };
          });
        }
        break;

      case "diverged":
        // Update disk content to latest version
        set((s) => {
          const e = s.files.get(filePath);
          if (!e) return s;
          const files = new Map(s.files);
          files.set(filePath, { ...e, diskContent });
          return { files };
        });
        break;
      default: {
        const _exhaustive: never = entry.state;
        throw new Error(`Unknown editor file state: ${String(_exhaustive)}`);
      }
    }
  },

  acceptDiskVersion: (filePath) => {
    set((s) => {
      const entry = s.files.get(filePath);
      if (!entry) return s;
      const files = new Map(s.files);
      files.set(filePath, {
        ...entry,
        state: "clean",
        pendingNonces: new Set(),
        savedSnapshots: new Map(),
        baseContent: entry.diskContent,
        diskContent: null,
      });
      return { files };
    });
  },

  keepMyChanges: (filePath) => {
    set((s) => {
      const entry = s.files.get(filePath);
      if (!entry) return s;
      const files = new Map(s.files);
      // Advance baseContent to diskContent so next merge has correct ancestor
      files.set(filePath, {
        ...entry,
        state: "dirty",
        baseContent: entry.diskContent ?? entry.baseContent,
        diskContent: null,
      });
      return { files };
    });
  },

  clearPendingNonce: (filePath, nonce) => {
    set((s) => {
      const entry = s.files.get(filePath);
      if (!entry || !entry.pendingNonces.has(nonce)) return s;
      const files = new Map(s.files);
      const pendingNonces = new Set(entry.pendingNonces);
      pendingNonces.delete(nonce);
      const savedSnapshots = new Map(entry.savedSnapshots);
      savedSnapshots.delete(nonce);
      files.set(filePath, { ...entry, pendingNonces, savedSnapshots });
      return { files };
    });
  },

  setBaseContent: (filePath, content) => {
    set((s) => {
      const entry = s.files.get(filePath);
      if (!entry) return s;
      const files = new Map(s.files);
      files.set(filePath, { ...entry, baseContent: content });
      return { files };
    });
  },

  registerEditorCallbacks: (filePath, getContent, applyContent) => {
    set((s) => {
      const entry = s.files.get(filePath);
      if (!entry) return s;
      const files = new Map(s.files);
      files.set(filePath, {
        ...entry,
        getEditorContent: getContent,
        applyMergedContent: applyContent,
      });
      return { files };
    });
  },

  unregisterEditorCallbacks: (filePath) => {
    set((s) => {
      const entry = s.files.get(filePath);
      if (!entry) return s;
      const files = new Map(s.files);
      files.set(filePath, { ...entry, getEditorContent: null, applyMergedContent: null });
      return { files };
    });
  },
}));

interface AutoMergeOptions {
  /** When true, conflicting hunks keep editor content (ours) over disk content (theirs). */
  preferOurs?: boolean;
  /** Nonces to clear from pending set (for format-echo merges in saving state). */
  matchedNonces?: string[];
  /** Override the merge base (defaults to entry.baseContent).
   *  Used for format-echo merges where the correct base is the content at save time,
   *  not the last-clean baseContent. */
  mergeBase?: string;
}

/**
 * Attempt 3-way auto-merge when an external change arrives during dirty/saving state.
 * Returns true if merge succeeded and state was updated, false to fall through to diverged.
 *
 * The imperative DOM update (applyMergedContent) runs OUTSIDE the Zustand set() callback
 * to avoid nested store mutations.
 */
function tryAutoMerge(
  entry: EditorFileEntry,
  diskContent: string,
  filePath: string,
  setFn: (
    fn: (s: {
      files: Map<string, EditorFileEntry>;
    }) => { files: Map<string, EditorFileEntry> } | { files: Map<string, EditorFileEntry> },
  ) => void,
  options?: AutoMergeOptions,
): boolean {
  const { baseContent, getEditorContent, applyMergedContent } = entry;
  const base = options?.mergeBase ?? baseContent;
  if (base === null || !getEditorContent || !applyMergedContent) return false;

  const ours = getEditorContent();
  if (ours === null) return false;

  const result = threeWayMerge(base, ours, diskContent, { preferOurs: options?.preferOurs });
  if (!result.ok) return false;

  // Apply merged content to editor DOM — returns canonicalized form.
  // Format-echo merges (matchedNonces present) are programmatic — content is already on disk.
  const programmatic = !!options?.matchedNonces;
  const canonicalized = applyMergedContent(result.merged, programmatic);
  const newBase = canonicalized ?? diskContent;

  setFn((s) => {
    const e = s.files.get(filePath);
    if (!e) return s;
    const files = new Map(s.files);

    // Clear matched nonces if provided (format-echo in saving state)
    let pendingNonces = e.pendingNonces;
    let savedSnapshots = e.savedSnapshots;
    if (options?.matchedNonces?.length) {
      pendingNonces = new Set(pendingNonces);
      savedSnapshots = new Map(savedSnapshots);
      for (const n of options.matchedNonces) {
        pendingNonces.delete(n);
        savedSnapshots.delete(n);
      }
    }

    // For format-echo merges (own-echo with differing content), compute the next state:
    // clean if merged content matches disk and all nonces cleared, otherwise dirty.
    // For regular external-change merges, preserve the existing state (dirty/saving).
    let nextState: EditorFileState;
    if (options?.matchedNonces) {
      const editorNow = getEditorContent();
      const mergedMatchesDisk = editorNow === diskContent;
      const allNoncesCleared = pendingNonces.size === 0;
      nextState = mergedMatchesDisk && allNoncesCleared ? "clean" : "dirty";
    } else {
      nextState = e.state;
    }

    files.set(filePath, {
      ...e,
      state: nextState,
      pendingNonces,
      savedSnapshots,
      baseContent: newBase,
      diskContent: null,
    });
    return { files };
  });

  return true;
}
