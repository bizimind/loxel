import { create } from "zustand";

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
  /** Keyed by file path; only a file's own tab publishes. */
  byFile: ReadonlyMap<string, EditorIndentation>;
  publish: (filePath: string, entry: EditorIndentation) => void;
  remove: (filePath: string) => void;
}

export const useEditorIndentationStore = create<EditorIndentationState>()((set) => ({
  byFile: new Map(),
  publish: (filePath, entry) => set((s) => ({ byFile: new Map(s.byFile).set(filePath, entry) })),
  remove: (filePath) =>
    set((s) => {
      if (!s.byFile.has(filePath)) return s;
      const byFile = new Map(s.byFile);
      byFile.delete(filePath);
      return { byFile };
    }),
}));
