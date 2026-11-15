import type { editor as monacoEditor } from "monaco-editor";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  type MergeCallbacks,
  useDiskSyncedContent,
  useFormatOnSave,
} from "@/hooks/use-disk-synced-content";
import { computeLineEdits } from "@/lib/compute-line-edits";
import { addSaveAction } from "@/lib/monaco-save-action";
import { toMonacoLanguage } from "@/lib/monaco-theme";
import { resolveLanguage } from "@/lib/resolve-language";
import { useEditorStateStore } from "@/store/editor-state";
import { selectEffectiveFileAssociations, useSettingsStore } from "@/store/settings-store";

import type { DiffSide } from "./SideBySideDiffView";

type IStandaloneCodeEditor = monacoEditor.IStandaloneCodeEditor;

const identity = (s: string) => s;

/** How long typing pauses before a diff with an editable side is recomputed */
export const REDIFF_DELAY_MS = 100;

/**
 * Editor-state key of an editable diff side (see `useEditorStateStore`): the view that owns the
 * side (a compare panel's id, or the working-tree file of a git diff) and which side it is.
 */
export function editableSideKey(ownerId: string, side: "old" | "new"): string {
  return `${ownerId}:${side}`;
}

/** Editor-state key of the editable working-tree side of a git diff, by the file's absolute path. */
export function workingTreeSideKey(absPath: string): string {
  return editableSideKey(`working-tree:${absPath}`, "new");
}

export interface EditableSide {
  /** Absolute path of the side's file */
  filePath: string;
  /** Live text of the side (edits included), or null until the file first loads */
  text: string | null;
  /**
   * The file's content as last read from or written to disk; changes only when the file on disk
   * does (a save of this side landing included)
   */
  diskText: string | null;
  /** Monaco language id */
  language: string;
  /** The file is missing on disk */
  isDeleted: boolean;
  /** The file changed on disk in a way that conflicts with this side's unsaved edits */
  isDiverged: boolean;
  /** The file could not be read at all */
  loadFailed: boolean;
  onContentChange: (value: string) => void;
  onEditorMount: (editor: IStandaloneCodeEditor) => void;
  acceptDisk: () => void;
  keepMine: () => void;
  recreateFile: () => Promise<void>;
}

/**
 * One editable side of a diff view (a compare panel side, or the working-tree side of a git diff):
 * a file loaded, autosaved and reconciled with disk like an editor tab (`useDiskSyncedContent`),
 * under its own editor-state key so it coexists with a tab open on the same file.
 *
 * The side's text lives here rather than in the editor, so the diff can follow it and, for an owner
 * that stays mounted (a compare panel switching to its unified view), edits survive the editor
 * unmounting. While an editor is mounted, disk content and merges are applied to it and reach the
 * text through its change events.
 */
export function useEditableSide(filePath: string, editorKey: string): EditableSide {
  const editorRef = useRef<IStandaloneCodeEditor | null>(null);
  const [text, setText] = useState<string | null>(null);
  const textRef = useRef<string | null>(null);

  // Set once the disk hook below exists; the merge callbacks only run after mount.
  const applyContentRef = useRef<(value: string, programmatic: boolean) => void>(() => {});
  const mergeCallbacks = useMemo<MergeCallbacks>(
    () => ({
      getContent: () => textRef.current,
      applyContent: (merged, programmatic) => {
        applyContentRef.current(merged, programmatic);
        return merged;
      },
    }),
    [],
  );

  const disk = useDiskSyncedContent<string>({
    filePath,
    editorKey,
    deserialize: identity,
    contentCache: null,
    mergeCallbacks,
  });
  const {
    diskContent,
    editorFileState,
    isDeleted,
    isError,
    isProgrammaticRef,
    getSerializedContentRef,
    handleChange,
    handleAcceptDisk,
    handleKeepMine,
    saveNow,
    recreateFile,
  } = disk;
  useFormatOnSave(disk);
  getSerializedContentRef.current = () => textRef.current;

  const onContentChange = useCallback(
    (value: string) => {
      textRef.current = value;
      setText(value);
      if (!isProgrammaticRef.current) handleChange(value);
    },
    [isProgrammaticRef, handleChange],
  );

  /**
   * Put `value` in the side: as line edits in the mounted editor (keeping the caret and undo
   * history), or straight into the text when no editor is mounted. `programmatic` content (from
   * disk) is not an edit and is not saved back.
   */
  applyContentRef.current = (value, programmatic) => {
    const model = editorRef.current?.getModel();
    if (!model) {
      isProgrammaticRef.current = programmatic;
      try {
        onContentChange(value);
      } finally {
        isProgrammaticRef.current = false;
      }
      return;
    }
    const edits = computeLineEdits(model, value);
    if (edits.length === 0) return;
    isProgrammaticRef.current = programmatic;
    try {
      model.pushEditOperations([], edits, () => []);
    } finally {
      isProgrammaticRef.current = false;
    }
  };

  // Follow disk while clean. The state is read live from the store, not from render-time values:
  // a keystroke between commit and this effect can already have made the side dirty.
  useEffect(() => {
    if (diskContent === null || textRef.current === diskContent) return;
    if (useEditorStateStore.getState().files.get(editorKey)?.state !== "clean") return;
    applyContentRef.current(diskContent, true);
  }, [diskContent, editorKey]);

  const onEditorMount = useCallback(
    (editor: IStandaloneCodeEditor) => {
      editorRef.current = editor;
      editor.onDidDispose(() => {
        if (editorRef.current === editor) editorRef.current = null;
      });
      addSaveAction(editor, () => void saveNow());
    },
    [saveNow],
  );

  const acceptDisk = useCallback(() => {
    const content = handleAcceptDisk();
    if (content !== null) applyContentRef.current(content, true);
  }, [handleAcceptDisk]);

  const fileAssociations = useSettingsStore(selectEffectiveFileAssociations);
  const language = useMemo(
    () => toMonacoLanguage(resolveLanguage(filePath, fileAssociations, diskContent)),
    [filePath, fileAssociations, diskContent],
  );

  return {
    filePath,
    text,
    diskText: diskContent,
    language,
    isDeleted,
    isDiverged: editorFileState === "diverged",
    loadFailed: isError && text === null,
    onContentChange,
    onEditorMount,
    acceptDisk,
    keepMine: handleKeepMine,
    recreateFile,
  };
}

/** The parts of a `DiffSide` that make it this editable side. */
export function editableDiffSideProps(
  side: EditableSide,
): Pick<DiffSide, "editable" | "onEditorMount"> {
  return {
    editable: { content: side.text ?? "", onContentChange: side.onContentChange },
    onEditorMount: side.onEditorMount,
  };
}
