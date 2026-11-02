import type { DockviewPanelApi } from "dockview-react";
import type { editor as monacoEditor } from "monaco-editor";
import * as monaco from "monaco-editor";
import { useCallback, useEffect, useRef, useState } from "react";

import { EditorBanner } from "@/components/editor/EditorBanner";
import { inlayHintsOption, useInlayHintsOption } from "@/hooks/useInlayHintsOption";
import { usePanelActivationFocus } from "@/hooks/usePanelActivationFocus";
import { CODE_EDITOR_OPTIONS } from "@/lib/code-editor-options";
import { detectIndentation } from "@/lib/detect-indentation";
import { getMonacoThemeName } from "@/lib/monaco-theme";
import {
  VIRTUAL_DOCUMENT_READ_ONLY_MESSAGE,
  virtualDocumentConnection,
  virtualDocumentFileName,
} from "@/lib/virtual-documents";
import { resolveIndentation, useSettingsStore } from "@/store/settings-store";
import { useUIStore } from "@/store/ui";

interface VirtualDocumentPanelProps {
  /** The document's URI, in Monaco's canonical form. */
  uri: string;
  /** The connection the tab opened on: the tab ends with it (see `virtual-documents.ts`). */
  connectionId: string;
  line?: number;
  column?: number;
  panelApi: DockviewPanelApi;
}

function reveal(
  editor: monacoEditor.IStandaloneCodeEditor,
  panelApi: DockviewPanelApi,
  line: number,
  column = 1,
): void {
  editor.revealLineInCenter(line);
  editor.setPosition({ lineNumber: line, column });
  editor.focus();
  // A one-time jump: the same jump asked for again would change no prop and do nothing.
  panelApi.updateParameters({ line: undefined, column: undefined });
}

/**
 * A read-only document a language server holds, such as a library's source: it has no file on disk,
 * so nothing here saves, watches or formats. Its model is synced to the server like an editor tab's,
 * which is what gives it hover, go to definition and symbols. The tab lasts as long as the connection
 * it opened on, so a tab restored after that, by a reload or a worktree switch, closes itself.
 */
export function VirtualDocumentPanel({
  uri,
  connectionId,
  line,
  column,
  panelApi,
}: VirtualDocumentPanelProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monacoEditor.IStandaloneCodeEditor | null>(null);
  const locationRef = useRef({ line, column });
  locationRef.current = { line, column };
  const [loadError, setLoadError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const darkMode = useUIStore((s) => s.darkMode);

  useInlayHintsOption(editorRef);
  usePanelActivationFocus(
    panelApi,
    useCallback(() => editorRef.current?.focus(), []),
  );

  useEffect(() => {
    const connection = virtualDocumentConnection(uri);
    if (connection?.id !== connectionId) {
      panelApi.close();
      return;
    }
    const closed = connection.onDidClose(() => panelApi.close());
    return () => closed.dispose();
  }, [uri, connectionId, panelApi]);

  useEffect(() => {
    const connection = virtualDocumentConnection(uri);
    const container = containerRef.current;
    if (connection?.id !== connectionId || !container) return;
    const tokens = new monaco.CancellationTokenSource();
    let revealFrame: number | undefined;
    let editor: monacoEditor.IStandaloneCodeEditor | undefined;
    let model: monacoEditor.ITextModel | undefined;

    connection.read(uri, tokens.token).then(
      (text) => {
        if (tokens.token.isCancellationRequested) return;
        setLoadError(false);
        const parsed = monaco.Uri.parse(uri);
        model =
          monaco.editor.getModel(parsed) ??
          monaco.editor.createModel(text, connection.languageId, parsed);
        editor = monaco.editor.create(container, {
          ...CODE_EDITOR_OPTIONS,
          inlayHints: inlayHintsOption(),
          model,
          theme: getMonacoThemeName(useUIStore.getState().darkMode),
          readOnly: true,
          readOnlyMessage: { value: VIRTUAL_DOCUMENT_READ_ONLY_MESSAGE },
        });
        editorRef.current = editor;
        // After `create`: the first editor flips the global `detectIndentation`, which resets models.
        model.updateOptions(
          resolveIndentation(useSettingsStore.getState().editor, virtualDocumentFileName(uri), {
            language: connection.languageId,
            editorConfig: {},
            detected: detectIndentation(text),
          }).indentation,
        );
        const { line: target, column: targetColumn } = locationRef.current;
        if (target) {
          revealFrame = requestAnimationFrame(() => {
            if (editor) reveal(editor, panelApi, target, targetColumn);
          });
        }
      },
      () => {
        if (!tokens.token.isCancellationRequested) setLoadError(true);
      },
    );

    return () => {
      tokens.cancel();
      tokens.dispose();
      if (revealFrame !== undefined) cancelAnimationFrame(revealFrame);
      editorRef.current = null;
      editor?.dispose();
      model?.dispose();
    };
  }, [uri, connectionId, attempt, panelApi]);

  // Going to another place in a document whose tab is already open.
  useEffect(() => {
    if (editorRef.current && line) reveal(editorRef.current, panelApi, line, column);
  }, [line, column, panelApi]);

  useEffect(() => {
    monaco.editor.setTheme(getMonacoThemeName(darkMode));
  }, [darkMode]);

  return (
    <div className="flex h-full w-full flex-col overflow-hidden">
      {loadError && (
        <EditorBanner
          tone="danger"
          message="The language server could not provide this source."
          actions={[{ label: "Retry", onClick: () => setAttempt((n) => n + 1) }]}
        />
      )}
      <div ref={containerRef} className="min-h-0 min-w-0 flex-1 overflow-hidden" />
    </div>
  );
}
