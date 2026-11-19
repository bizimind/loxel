import { create } from "zustand";

import type { EditorKey } from "@/store/editor-state";
import type { IndentationLayer, IndentationResolution } from "@/store/settings-store";

/**
 * What a code editor tab publishes about its file for the status bar and the Change Indentation
 * action, which live outside the tab.
 */
export interface EditorIndentation {
  resolution: IndentationResolution;
  eol: "LF" | "CRLF";
  /** Choose the file's indentation in this tab, over every other source; null goes back to them. */
  setFileChoice: (choice: IndentationLayer | null) => void;
  /** Rewrite the file's indentation to spaces or tabs as one undo step, and choose that style. */
  convert: (insertSpaces: boolean) => void;
}

interface EditorIndentationState {
  /** Keyed by the file's tab key (its server and path); only a file's own tab publishes. */
  byFile: ReadonlyMap<EditorKey, EditorIndentation>;
  publish: (key: EditorKey, entry: EditorIndentation) => void;
  /** Removes `entry`, unless another tab of the file has published since. */
  remove: (key: EditorKey, entry: EditorIndentation) => void;
}

export const useEditorIndentationStore = create<EditorIndentationState>()((set) => ({
  byFile: new Map(),
  publish: (key, entry) => set((s) => ({ byFile: new Map(s.byFile).set(key, entry) })),
  remove: (key, entry) =>
    set((s) => {
      if (s.byFile.get(key) !== entry) return s;
      const byFile = new Map(s.byFile);
      byFile.delete(key);
      return { byFile };
    }),
}));
