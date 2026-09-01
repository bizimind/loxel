import type { editor as monacoEditor } from "monaco-editor";

import * as monaco from "monaco-editor";
import { useEffect, useRef } from "react";

import type { TypeScriptDiagnostic } from "@/api/diagnostics-model";
import type { PlacedThread } from "@/api/review-model";

import { getMonacoThemeName } from "@/lib/monaco-theme";

import type { ChangeRegion } from "./change-regions";
import type { LineRange } from "./unchanged-regions";

import { buildCommentDecorations } from "../comments/comment-decorations";
import { buildMonacoDecorations } from "./monaco-decorations";

type IStandaloneCodeEditor = monacoEditor.IStandaloneCodeEditor;

/** Private Monaco API for hiding line ranges */
interface EditorWithHiddenAreas extends IStandaloneCodeEditor {
  setHiddenAreas(
    ranges: { startLineNumber: number; endLineNumber: number }[],
    source?: unknown,
  ): void;
}

export interface ViewZoneDescriptor {
  afterLineNumber: number;
  heightInPx: number;
  label: string;
  onClick: () => void;
}

interface EditorPanelProps {
  content: string;
  language: string;
  filePath?: string;
  gitRef?: string;
  /** Disambiguate URI when left/right panels show the same file+ref. */
  side?: "old" | "new";
  changeRegions: ChangeRegion[];
  darkMode: boolean;
  diagnostics?: TypeScriptDiagnostic[];
  hiddenRanges?: LineRange[];
  viewZones?: ViewZoneDescriptor[];
  /** Placed comment threads to render as decorations */
  commentThreads?: PlacedThread[];
  /** Lines to highlight as the current selection (for comment anchoring feedback) */
  selectionHighlightLines?: { startLine: number; endLine: number } | null;
  /** Called when the user's selection changes */
  onSelectionChange?: (sel: { startLine: number; endLine: number } | null) => void;
  onEditorMount: (editor: IStandaloneCodeEditor) => void;
}

export function EditorPanel({
  content,
  language,
  filePath,
  gitRef,
  side,
  changeRegions,
  darkMode,
  diagnostics,
  hiddenRanges,
  viewZones,
  commentThreads,
  selectionHighlightLines,
  onSelectionChange,
  onEditorMount,
}: EditorPanelProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<IStandaloneCodeEditor | null>(null);
  const decorationsRef = useRef<monacoEditor.IEditorDecorationsCollection | null>(null);
  const commentDecorationsRef = useRef<monacoEditor.IEditorDecorationsCollection | null>(null);
  const selectionHighlightRef = useRef<monacoEditor.IEditorDecorationsCollection | null>(null);

  // Keep callback refs stable for event handlers
  const onSelectionChangeRef = useRef(onSelectionChange);
  onSelectionChangeRef.current = onSelectionChange;

  // Mount editor once
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // Create model with a loxel:// URI so the HoverProvider can extract ref + file path.
    // Include side in the fragment to disambiguate when both panels show the same file+ref.
    const authority = gitRef ?? "HEAD";
    const path = filePath ?? "untitled";
    const uri = monaco.Uri.from({ scheme: "loxel", authority, path: `/${path}`, fragment: side });
    let model = monaco.editor.getModel(uri);
    if (model) {
      if (model.getValue() !== content) model.setValue(content);
      if (model.getLanguageId() !== language) monaco.editor.setModelLanguage(model, language);
    } else {
      model = monaco.editor.createModel(content, language, uri);
    }

    const editor = monaco.editor.create(container, {
      model,
      theme: getMonacoThemeName(darkMode),
      readOnly: true,
      domReadOnly: true,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      renderLineHighlight: "none",
      lineHeight: 22,
      fontSize: 13,
      fontFamily: "'JetBrains Mono', ui-monospace, SFMono-Regular, 'SF Mono', Menlo, monospace",
      automaticLayout: true,
      contextmenu: false,
      scrollbar: { vertical: "hidden", horizontal: "hidden", handleMouseWheel: false },
      overviewRulerLanes: 0,
      hideCursorInOverviewRuler: true,
      overviewRulerBorder: false,
      lineNumbers: "off",
      glyphMargin: false,
      folding: false,
      fixedOverflowWidgets: true,
      stickyScroll: { enabled: false },
      lineDecorationsWidth: 0,
      lineNumbersMinChars: 0,
      padding: { top: 0, bottom: 22 * 8 },
    });

    editorRef.current = editor;
    decorationsRef.current = editor.createDecorationsCollection(
      buildMonacoDecorations(changeRegions),
    );
    commentDecorationsRef.current = editor.createDecorationsCollection([]);
    selectionHighlightRef.current = editor.createDecorationsCollection([]);

    // Selection/cursor change handler — fires for both selections and caret moves
    editor.onDidChangeCursorSelection((e) => {
      const sel = e.selection;
      if (sel.isEmpty()) {
        // Caret with no selection — report the caret line as a single-line range
        onSelectionChangeRef.current?.({
          startLine: sel.startLineNumber,
          endLine: sel.startLineNumber,
        });
      } else {
        onSelectionChangeRef.current?.({
          startLine: sel.startLineNumber,
          endLine: sel.endLineNumber,
        });
      }
    });

    onEditorMount(editor);

    return () => {
      commentDecorationsRef.current = null;
      selectionHighlightRef.current = null;
      decorationsRef.current = null;
      editorRef.current = null;
      const editorModel = editor.getModel();
      editor.dispose();
      editorModel?.dispose();
    };
    // Mount-only effect — deps intentionally omitted
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Update content
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    const model = editor.getModel();
    if (model && model.getValue() !== content) {
      model.setValue(content);
    }
  }, [content]);

  // Update language
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    const model = editor.getModel();
    if (model) {
      monaco.editor.setModelLanguage(model, language);
    }
  }, [language]);

  // Update theme
  useEffect(() => {
    monaco.editor.setTheme(getMonacoThemeName(darkMode));
  }, [darkMode]);

  // Update decorations
  useEffect(() => {
    if (decorationsRef.current) {
      decorationsRef.current.set(buildMonacoDecorations(changeRegions));
    }
  }, [changeRegions]);

  // Update comment decorations
  useEffect(() => {
    if (commentDecorationsRef.current && side) {
      commentDecorationsRef.current.set(buildCommentDecorations(commentThreads ?? [], side));
    }
  }, [commentThreads, side]);

  // Update selection highlight (visual feedback for line range being commented on)
  useEffect(() => {
    if (!selectionHighlightRef.current) return;
    if (!selectionHighlightLines) {
      selectionHighlightRef.current.set([]);
      return;
    }
    selectionHighlightRef.current.set([
      {
        range: {
          startLineNumber: selectionHighlightLines.startLine,
          startColumn: 1,
          endLineNumber: selectionHighlightLines.endLine,
          endColumn: 1,
        },
        options: {
          isWholeLine: true,
          className: "comment-selection-highlight",
          marginClassName: "comment-selection-highlight",
        },
      },
    ]);
  }, [selectionHighlightLines]);

  // Apply TypeScript diagnostics as Monaco markers
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    const model = editor.getModel();
    if (!model) return;

    if (!diagnostics || diagnostics.length === 0) {
      monaco.editor.setModelMarkers(model, "typescript", []);
      return;
    }

    const markers: monaco.editor.IMarkerData[] = diagnostics.map((d) => ({
      startLineNumber: d.line,
      startColumn: d.col,
      endLineNumber: d.line,
      endColumn: d.col + 1,
      message: `TS${d.code}: ${d.message}`,
      severity:
        d.severity === "error" ? monaco.MarkerSeverity.Error : monaco.MarkerSeverity.Warning,
      source: "typescript",
    }));

    monaco.editor.setModelMarkers(model, "typescript", markers);
  }, [diagnostics]);

  // Apply hidden areas (collapsed unchanged regions)
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    const editorWithHidden = editor as EditorWithHiddenAreas;
    if (typeof editorWithHidden.setHiddenAreas !== "function") return;
    editorWithHidden.setHiddenAreas(
      (hiddenRanges ?? []).map((r) => ({
        startLineNumber: r.startLineNumber,
        endLineNumber: r.endLineNumber,
      })),
      "diff-collapse",
    );
  }, [hiddenRanges]);

  // Apply view zones (thin spacers in collapsed regions)
  // The .diff-collapse-spacer CSS uses position:relative + z-index to lift it above
  // Monaco's view-lines layer, making DOM click events work directly.
  const viewZoneIdsRef = useRef<string[]>([]);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || !viewZones) return;

    editor.changeViewZones((accessor) => {
      // Remove previous zones
      for (const id of viewZoneIdsRef.current) accessor.removeZone(id);
      viewZoneIdsRef.current = [];

      for (const zone of viewZones) {
        const domNode = document.createElement("div");
        domNode.className = "diff-collapse-spacer";
        domNode.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          zone.onClick();
        });

        const id = accessor.addZone({
          afterLineNumber: zone.afterLineNumber,
          heightInPx: zone.heightInPx,
          domNode,
          showInHiddenAreas: true,
        });
        viewZoneIdsRef.current.push(id);
      }
    });
  }, [viewZones]);

  return <div ref={containerRef} className="h-full w-full" />;
}
