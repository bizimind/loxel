import type { editor as monacoEditor } from "monaco-editor";
import type { MutableRefObject } from "react";

import { ChevronDown, ChevronRight, PlusIcon, XIcon } from "lucide-react";
import * as monaco from "monaco-editor";
import { useCallback, useEffect, useRef, useState } from "react";

import { getMonacoThemeName } from "@/lib/monaco-theme";
import { useUIStore } from "@/store/ui";

type IStandaloneCodeEditor = monacoEditor.IStandaloneCodeEditor;

/**
 * Per-file UI state — survives tab switches within the same session.
 * Growth is bounded by the number of distinct files opened (typically dozens),
 * and entries are lightweight (boolean / number), so no eviction is needed.
 */
const collapseState = new Map<string, boolean>();
const savedHeight = new Map<string, number>();

const MIN_HEIGHT = 66; // ~3 lines at 22px
const DEFAULT_MAX_HEIGHT = 300;
const LINE_HEIGHT = 22;
const PADDING_TOP = 4;
const PADDING_BOTTOM = 4;

function computeAutoHeight(lineCount: number): number {
  const content = lineCount * LINE_HEIGHT + PADDING_TOP + PADDING_BOTTOM;
  return Math.max(MIN_HEIGHT, Math.min(DEFAULT_MAX_HEIGHT, content));
}

function getModelUri(filePath: string): monaco.Uri {
  return monaco.Uri.from({ scheme: "file", path: `/__frontmatter__/${filePath}.yaml` });
}

interface FrontmatterEditorProps {
  filePath: string;
  value: string | null;
  onChange: (yaml: string | null) => void;
  isProgrammaticRef: MutableRefObject<boolean>;
}

export function FrontmatterEditor({
  filePath,
  value,
  onChange,
  isProgrammaticRef,
}: FrontmatterEditorProps) {
  const darkMode = useUIStore((s) => s.darkMode);
  const containerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<IStandaloneCodeEditor | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  // Collapse: default to expanded if frontmatter exists, collapsed if null
  const [collapsed, setCollapsed] = useState(() => collapseState.get(filePath) ?? value === null);
  // If the user has manually resized, use that; otherwise auto-height from line count
  const [height, setHeight] = useState(
    () => savedHeight.get(filePath) ?? computeAutoHeight(value ? value.split("\n").length : 1),
  );
  // Track whether user has manually resized (disables auto-height on content change)
  const manuallyResizedRef = useRef(savedHeight.has(filePath));

  // Persist collapse state per file
  const toggleCollapse = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev;
      collapseState.set(filePath, next);
      return next;
    });
  }, [filePath]);

  // Model lifecycle — independent of collapse state to preserve undo history.
  // Created when frontmatter exists, disposed when frontmatter is removed or component unmounts.
  useEffect(() => {
    if (value === null) return;

    const uri = getModelUri(filePath);
    if (!monaco.editor.getModel(uri)) {
      monaco.editor.createModel(value, "yaml", uri);
    }

    return () => {
      // Dispose model on unmount or when frontmatter is removed
      monaco.editor.getModel(uri)?.dispose();
    };
    // Only react to frontmatter existence and filePath changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value !== null, filePath]);

  // Editor instance lifecycle — re-created on collapse/expand toggle.
  // The model persists across these cycles, so undo history is preserved.
  useEffect(() => {
    if (value === null || collapsed) return;
    const container = containerRef.current;
    if (!container) return;

    const uri = getModelUri(filePath);
    const model = monaco.editor.getModel(uri);
    if (!model) return;

    // Sync model content if it drifted (e.g., value changed while collapsed)
    if (model.getValue() !== value) {
      model.setValue(value);
    }

    const editor = monaco.editor.create(container, {
      model,
      theme: getMonacoThemeName(darkMode),
      minimap: { enabled: false },
      lineNumbers: "on",
      glyphMargin: false,
      folding: false,
      wordWrap: "on",
      scrollBeyondLastLine: false,
      lineHeight: LINE_HEIGHT,
      fontSize: 13,
      fontFamily: "'JetBrains Mono', ui-monospace, SFMono-Regular, 'SF Mono', Menlo, monospace",
      automaticLayout: true,
      contextmenu: false,
      renderLineHighlight: "none",
      overviewRulerLanes: 0,
      hideCursorInOverviewRuler: true,
      scrollbar: { vertical: "hidden", horizontal: "auto", alwaysConsumeMouseWheel: false },
      padding: { top: PADDING_TOP, bottom: PADDING_BOTTOM },
      stickyScroll: { enabled: false },
      fixedOverflowWidgets: true,
    });

    editorRef.current = editor;

    // Auto-height (only when user hasn't manually resized)
    const updateHeight = () => {
      if (manuallyResizedRef.current) return;
      const lineCount = editor.getModel()?.getLineCount() ?? 1;
      setHeight(computeAutoHeight(lineCount));
    };
    updateHeight();

    const contentDisposable = editor.onDidChangeModelContent(() => {
      updateHeight();
      if (isProgrammaticRef.current) return;
      onChangeRef.current(editor.getModel()?.getValue() ?? "");
    });

    return () => {
      editorRef.current = null;
      contentDisposable.dispose();
      // Dispose only the editor, NOT the model — model lifecycle is managed separately
      editor.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value !== null, collapsed, filePath]);

  // Sync external value changes into Monaco (e.g., disk sync)
  useEffect(() => {
    if (value === null) return;
    const model = editorRef.current?.getModel();
    if (model && model.getValue() !== value) {
      isProgrammaticRef.current = true;
      model.setValue(value);
      isProgrammaticRef.current = false;
    }
  }, [value, isProgrammaticRef]);

  // Update theme
  useEffect(() => {
    monaco.editor.setTheme(getMonacoThemeName(darkMode));
  }, [darkMode]);

  const handleAdd = useCallback(() => {
    collapseState.set(filePath, false);
    setCollapsed(false);
    onChange("");
  }, [filePath, onChange]);

  const handleRemove = useCallback(() => {
    onChange(null);
  }, [onChange]);

  // Resize handle — drag to adjust editor height
  const handleResizeStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const startY = e.clientY;
      const startHeight = height;

      const onMouseMove = (ev: MouseEvent) => {
        const newHeight = Math.max(MIN_HEIGHT, startHeight + (ev.clientY - startY));
        setHeight(newHeight);
        savedHeight.set(filePath, newHeight);
        manuallyResizedRef.current = true;
      };

      const onMouseUp = () => {
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);
      };

      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
    },
    [height, filePath],
  );

  // No frontmatter — show add button
  if (value === null) {
    return (
      <div className="border-border flex items-center border-b px-3 py-1">
        <button
          onClick={handleAdd}
          className="text-muted-foreground hover:text-foreground flex items-center gap-1 text-xs"
        >
          <PlusIcon className="size-3" />
          Add frontmatter
        </button>
      </div>
    );
  }

  return (
    <div className="border-border border-b">
      <div className="flex items-center gap-1 px-2 py-1">
        <button
          onClick={toggleCollapse}
          className="text-muted-foreground hover:text-foreground flex items-center gap-1 text-xs font-medium"
        >
          {collapsed ? <ChevronRight className="size-3" /> : <ChevronDown className="size-3" />}
          Frontmatter
        </button>
        <button
          onClick={handleRemove}
          title="Remove frontmatter"
          className="text-muted-foreground hover:text-foreground ml-auto flex items-center"
        >
          <XIcon className="size-3" />
        </button>
      </div>
      {!collapsed && (
        <>
          <div ref={containerRef} style={{ height }} />
          {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions */}
          <div
            onMouseDown={handleResizeStart}
            className="group/resize relative h-0 shrink-0 cursor-row-resize"
          >
            {/* Visual line: 1px */}
            <div className="bg-border group-hover/resize:bg-primary/50 absolute inset-x-0 top-0 h-px transition-colors" />
            {/* Hit target: 3px centered on the visual line */}
            <div className="absolute inset-x-0 -top-[1px] h-[3px]" />
          </div>
        </>
      )}
    </div>
  );
}
