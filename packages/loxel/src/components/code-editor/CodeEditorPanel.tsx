import { useQuery } from "@tanstack/react-query";
import type { DockviewPanelApi } from "dockview-react";
import type { editor as monacoEditor } from "monaco-editor";
import * as monaco from "monaco-editor";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import * as api from "@/api/client";
import type { TypeScriptDiagnostic } from "@/api/diagnostics-model";
import type { EditorConfigProperties } from "@/api/editorconfig-model";
import { TextMateScopeInspector } from "@/components/code-editor/TextMateScopeInspector";
import { usePanelWorktreePath } from "@/components/dockview/panel-context";
import { ConflictBanner } from "@/components/editor/ConflictBanner";
import { DeletedFileBanner } from "@/components/editor/DeletedFileBanner";
import { MovedFileBanner } from "@/components/editor/MovedFileBanner";
import {
  type MergeCallbacks,
  useDiskSyncedContent,
  useFormatOnSave,
} from "@/hooks/use-disk-synced-content";
import { useFirstLoadGate } from "@/hooks/useFirstLoadGate";
import { usePanelActivationFocus } from "@/hooks/usePanelActivationFocus";
import { computeLineEdits } from "@/lib/compute-line-edits";
import { detectIndentation } from "@/lib/detect-indentation";
import { applyEditorConfigOnSave } from "@/lib/editorconfig-save-actions";
import { removeDollarSchema, setDollarSchema } from "@/lib/json-schema-registry";
import { validateStrictJson } from "@/lib/json-strict-validator";
import { fileSchemeLanguages } from "@/lib/lsp-clients";
import { addSaveAction } from "@/lib/monaco-save-action";
import { getMonacoThemeName, toMonacoLanguage } from "@/lib/monaco-theme";
import { resolveLanguage } from "@/lib/resolve-language";
import { requestSchemasForOpenFiles } from "@/lib/schema-sync";
import { inspectTokenAtPosition } from "@/lib/textmate-inspector";
import { hasTypeScriptDiagnostics } from "@/lib/typescript-files";
import { queryKeys } from "@/queries/query-keys";
import { type EditorIndentation, useEditorIndentationStore } from "@/store/editor-indentation";
import { useEditorStateStore } from "@/store/editor-state";
import { useSchemaConsentStore } from "@/store/schema-consent";
import {
  type IndentationLayer,
  resolveIndentation,
  selectEffectiveFileAssociations,
  useSettingsStore,
} from "@/store/settings-store";
import { useUIStore } from "@/store/ui";

type IStandaloneCodeEditor = monacoEditor.IStandaloneCodeEditor;

const identity = (s: string) => s;

const NO_EDITORCONFIG: EditorConfigProperties = {};

/** Longest the editor waits read-only for a file's `.editorconfig` before using the fallbacks. */
const EDITORCONFIG_GATE_MS = 500;

function rulersFor(editorConfig: EditorConfigProperties): number[] {
  return editorConfig.maxLineLength === undefined ? [] : [editorConfig.maxLineLength];
}

function normalizeHex(color: string): string {
  const c = color.toLowerCase().replace(/^#/, "");
  if (c.length === 8 && c.endsWith("ff")) return c.slice(0, 6);
  return c;
}

// Monaco internals for reading the resolved token color (including semantic overrides).
// Lazy-loaded because these are internal ESM modules without type declarations.
let monacoTokenInternals: {
  TokenizationRegistry: {
    get(id: string): TokenSupport | null;
    getColorMap(): MonacoColor[] | null;
  };
  TokenMetadata: { getForeground(metadata: number): number };
} | null = null;

interface TokenSupport {
  getInitialState(): unknown;
  tokenize(line: string, hasEOL: boolean, state: unknown): { endState: unknown };
  tokenizeEncoded(line: string, hasEOL: boolean, state: unknown): { tokens: Uint32Array };
}

interface MonacoColor {
  toString(): string;
}

void loadMonacoTokenInternals();

async function loadMonacoTokenInternals(): Promise<NonNullable<typeof monacoTokenInternals>> {
  const [languages, attrs] = await Promise.all([
    import("monaco-editor/esm/vs/editor/common/languages.js" as string),
    import("monaco-editor/esm/vs/editor/common/encodedTokenAttributes.js" as string),
  ]);
  const result = {
    TokenizationRegistry: languages.TokenizationRegistry,
    TokenMetadata: attrs.TokenMetadata,
  };
  monacoTokenInternals = result;
  return result;
}

function getResolvedMonacoColor(
  editor: monacoEditor.IStandaloneCodeEditor,
  pos: monaco.IPosition,
): string | null {
  if (!monacoTokenInternals) return null;
  const internals = monacoTokenInternals;

  const model = editor.getModel();
  if (!model) return null;

  const tokenSupport = internals.TokenizationRegistry.get(model.getLanguageId());
  if (!tokenSupport) return null;

  let state = tokenSupport.getInitialState();
  for (let i = 1; i < pos.lineNumber; i++) {
    const result = tokenSupport.tokenize(model.getLineContent(i), true, state);
    state = result.endState;
  }

  const encoded = tokenSupport.tokenizeEncoded(model.getLineContent(pos.lineNumber), true, state);
  const tokens2 = encoded.tokens;

  let tokenIndex = 0;
  for (let i = tokens2.length / 2 - 1; i >= 0; i--) {
    if (pos.column - 1 >= tokens2[i * 2]!) {
      tokenIndex = i;
      break;
    }
  }

  const metadata = tokens2[tokenIndex * 2 + 1]!;
  const fgIndex = internals.TokenMetadata.getForeground(metadata);
  const colorMap = internals.TokenizationRegistry.getColorMap();
  if (!colorMap?.[fgIndex]) return null;

  return colorMap[fgIndex].toString();
}

/** Long enough that a schema URL being typed is not taken for the finished address and prompted. */
const SCHEMA_DETECTION_DELAY_MS = 2000;

/** Extract $schema URL from the first few lines of a JSON file. */
const DOLLAR_SCHEMA_RE = /"\$schema"\s*:\s*"([^"]+)"/;

function extractDollarSchema(content: string): string | null {
  // Only check the first 5 lines for performance
  const head = content.slice(0, content.split("\n", 5).join("\n").length);
  const match = DOLLAR_SCHEMA_RE.exec(head || content.slice(0, 500));
  return match?.[1] ?? null;
}

interface CodeEditorPanelProps {
  filePath: string;
  /** Previous path when the file was moved outside Loxel (tab parameter); shows a notice. */
  movedFrom?: string;
  line?: number;
  column?: number;
  onClose: () => void;
  panelApi: DockviewPanelApi;
}

export function CodeEditorPanel({
  filePath,
  line,
  column,
  movedFrom,
  onClose,
  panelApi,
}: CodeEditorPanelProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<IStandaloneCodeEditor | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const inspectorWidgetRef = useRef<TextMateScopeInspector | null>(null);
  const inspectorOpenRef = useRef(false);

  usePanelActivationFocus(
    panelApi,
    useCallback(() => editorRef.current?.focus(), []),
  );

  // Track initial line/col for mount-time navigation (consumed once).
  // The `mounted` ref prevents the prop-change effect from racing with the mount effect.
  const initialLineRef = useRef(line);
  const initialColRef = useRef(column);
  const mountedRef = useRef(false);

  /** Consume initialLineRef/initialColRef and navigate via rAF. Returns the rAF id. */
  function navigateToInitialPosition(editor: IStandaloneCodeEditor): number {
    const ln = initialLineRef.current!;
    const col = initialColRef.current ?? 1;
    initialLineRef.current = undefined;
    initialColRef.current = undefined;
    return requestAnimationFrame(() => {
      editor.revealLineInCenter(ln);
      editor.setPosition({ lineNumber: ln, column: col });
      editor.focus();
      mountedRef.current = true;
    });
  }

  const darkMode = useUIStore((s) => s.darkMode);
  const darkModeRef = useRef(darkMode);
  darkModeRef.current = darkMode;
  const editorSettings = useSettingsStore((s) => s.editor);

  // Merge callbacks for 3-way auto-merge. Refs are populated in the mount effect.
  const mergeGetRef = useRef<(() => string | null) | null>(null);
  const mergeApplyRef = useRef<((s: string, programmatic: boolean) => string | null) | null>(null);
  const mergeCallbacks = useMemo<MergeCallbacks>(
    () => ({
      getContent: () => mergeGetRef.current?.() ?? null,
      applyContent: (s, p) => mergeApplyRef.current?.(s, p) ?? null,
    }),
    [],
  );

  const {
    diskContent,
    editorFileState,
    isDeleted,
    saveNow,
    recreateFile,
    saveOptionsRef,
    autoSaveOptionsRef,
    handleAcceptDisk: hookAcceptDisk,
    handleKeepMine,
    handleChange,
    isProgrammaticRef,
    getSerializedContentRef,
  } = useDiskSyncedContent<string>({
    filePath,
    deserialize: identity,
    contentCache: null,
    mergeCallbacks,
  });

  // Keep save option refs in sync with formatting settings.
  useFormatOnSave({ saveOptionsRef, autoSaveOptionsRef });

  const panelWorktreePath = usePanelWorktreePath();
  const fileAssociations = useSettingsStore(selectEffectiveFileAssociations);
  const resolvedLang = useMemo(
    () => resolveLanguage(filePath, fileAssociations, diskContent),
    [filePath, fileAssociations, diskContent],
  );
  const resolvedLangRef = useRef(resolvedLang);
  resolvedLangRef.current = resolvedLang;
  const language = useMemo(() => toMonacoLanguage(resolvedLang), [resolvedLang]);

  // Refetched when an `.editorconfig` above the file changes (see ws-bridge).
  const editorConfigQuery = useQuery({
    queryKey: queryKeys.editorConfig(filePath, panelWorktreePath ?? undefined),
    queryFn: ({ signal }) => api.getEditorConfig(filePath, panelWorktreePath, signal),
  });
  const { data: editorConfigData } = editorConfigQuery;
  // Read-only until the first `.editorconfig` load settles, so the first edit already indents by
  // it; never longer than the cap, and not while the query is paused (offline) or after an error.
  const editorConfigPending = useFirstLoadGate(
    editorConfigQuery.isPending && editorConfigQuery.fetchStatus !== "paused",
    EDITORCONFIG_GATE_MS,
  );
  const editorConfig = editorConfigData?.properties ?? NO_EDITORCONFIG;
  const editorConfigRef = useRef(editorConfig);
  editorConfigRef.current = editorConfig;
  const editorConfigPendingRef = useRef(editorConfigPending);
  editorConfigPendingRef.current = editorConfigPending;

  // Detected when the file's content is loaded or replaced from disk, not on the echoes of its own
  // saves, so neither typing nor a conversion shifts it.
  const [detectedIndentation, setDetectedIndentation] = useState(() =>
    diskContent === null ? undefined : detectIndentation(diskContent),
  );
  // Chosen with Change Indentation; lasts while the tab is open.
  const [fileIndentation, setFileIndentation] = useState<IndentationLayer | null>(null);
  const indentation = useMemo(
    () =>
      resolveIndentation(editorSettings, filePath, {
        language: resolvedLang,
        editorConfig,
        detected: detectedIndentation,
        fileChoice: fileIndentation ?? undefined,
      }),
    [editorSettings, filePath, resolvedLang, editorConfig, detectedIndentation, fileIndentation],
  );
  const indentationRef = useRef(indentation);
  indentationRef.current = indentation;
  const [eol, setEol] = useState<"LF" | "CRLF">("LF");

  // Fetch project-wide diagnostics scoped to the panel's worktree (not the global active one),
  // only for files tsc can report on.
  const { data: diagData } = useQuery({
    queryKey: queryKeys.diagnostics(null, undefined, panelWorktreePath ?? undefined),
    queryFn: () => api.getDiagnostics(panelWorktreePath!),
    enabled: !!panelWorktreePath && hasTypeScriptDiagnostics(filePath),
  });

  // Filter diagnostics to this file (d.file is relative, filePath is absolute)
  const relativePath =
    panelWorktreePath && filePath.startsWith(panelWorktreePath + "/")
      ? filePath.slice(panelWorktreePath.length + 1)
      : filePath;
  const diagnostics = useMemo<TypeScriptDiagnostic[]>(() => {
    if (!diagData?.diagnostics) return [];
    return diagData.diagnostics.filter((d) => d.file === relativePath);
  }, [diagData, relativePath]);

  // Mount editor once
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const content = diskContent ?? "";

    const useFileScheme = fileSchemeLanguages.has(language);
    const uri = useFileScheme
      ? monaco.Uri.from({ scheme: "file", path: filePath })
      : monaco.Uri.from({ scheme: "loxel", authority: "HEAD", path: filePath });
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
      readOnly: editorConfigPendingRef.current,
      rulers: rulersFor(editorConfigRef.current),
      // Editor-level tabSize/insertSpaces are global in standalone Monaco: setting them would reset
      // every open model's indentation. Indentation is set per model below; this constant flag only
      // keeps Monaco from overriding it.
      detectIndentation: false,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      lineHeight: 22,
      fontSize: 13,
      fontFamily: "'JetBrains Mono', ui-monospace, SFMono-Regular, 'SF Mono', Menlo, monospace",
      automaticLayout: true,
      contextmenu: false,
      lineNumbers: "on",
      glyphMargin: true,
      folding: true,
      fixedOverflowWidgets: true,
      suggest: { insertMode: "replace", showIcons: true },
      suggestFontSize: 13,
      suggestLineHeight: 28,
      "semanticHighlighting.enabled": true,
      stickyScroll: { enabled: false },
      renderLineHighlight: "line",
      scrollbar: { vertical: "auto", horizontal: "auto" },
      overviewRulerLanes: 3,
      padding: { top: 4 },
      // `gotoLocation` keeps Monaco's defaults: several targets open a peek widget, which shows
      // files no tab has open through peek-text-models.ts; a single one opens a tab through the
      // editor opener (editor-opener.ts).
    });

    editorRef.current = editor;
    // After `create`: the first editor flips the global `detectIndentation`, which resets models.
    model.updateOptions(indentationRef.current.indentation);
    setEol(model.getEOL() === "\r\n" ? "CRLF" : "LF");

    // TextMate scope inspector — shows real TextMate scope stack instead of
    // the lossy reverse-mapped scopes from shikiToMonaco.
    let inspectTimer: ReturnType<typeof setTimeout> | undefined;

    function runInspection(): void {
      const widget = inspectorWidgetRef.current;
      if (!widget) return;
      const model = editor.getModel();
      const pos = editor.getPosition();
      if (!model || !pos) return;

      widget.setEditorPosition(pos);

      const lineText = model.getLineContent(pos.lineNumber);
      const lang = resolvedLangRef.current;
      if (!lang) {
        widget.update(null, "No language detected");
        editor.layoutContentWidget(widget);
        return;
      }
      const themeName = "loxel-dark";
      inspectTokenAtPosition(lineText, pos.column, lang, themeName)
        .then((data) => {
          if (data) {
            const resolvedColor = getResolvedMonacoColor(editor, pos);
            if (
              resolvedColor &&
              data.foregroundColor &&
              normalizeHex(resolvedColor) !== normalizeHex(data.foregroundColor)
            ) {
              data.semanticOverride = { foregroundColor: resolvedColor };
            }
          }
          widget.update(data);
          editor.layoutContentWidget(widget);
        })
        .catch(() => {
          widget.update(null);
          editor.layoutContentWidget(widget);
        });
    }

    const cursorDisposable = editor.onDidChangeCursorPosition(() => {
      if (!inspectorOpenRef.current) return;
      clearTimeout(inspectTimer);
      inspectTimer = setTimeout(runInspection, 100);
    });

    editor.addAction({
      id: "inspect-textmate-scopes",
      label: "Developer: Inspect TextMate Scopes",
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyI],
      run: () => {
        if (inspectorOpenRef.current) {
          inspectorOpenRef.current = false;
          if (inspectorWidgetRef.current) {
            editor.removeContentWidget(inspectorWidgetRef.current);
            inspectorWidgetRef.current.dispose();
            inspectorWidgetRef.current = null;
          }
        } else {
          inspectorOpenRef.current = true;
          const widget = new TextMateScopeInspector(() => {
            inspectorOpenRef.current = false;
            editor.removeContentWidget(widget);
            widget.dispose();
            inspectorWidgetRef.current = null;
          });
          inspectorWidgetRef.current = widget;
          editor.addContentWidget(widget);
          runInspection();
        }
      },
    });

    // Whether the last user change was an undo or redo. The autosave that follows it skips the
    // save actions, which would otherwise redo what the user just undid (and clear redo).
    let lastChangeWasUndo = false;
    getSerializedContentRef.current = (reason) => {
      if (reason === "explicit" || !lastChangeWasUndo) {
        // The save actions are part of what gets written, not an edit that needs saving again.
        isProgrammaticRef.current = true;
        try {
          applyEditorConfigOnSave(editor, editorConfigRef.current, reason);
        } finally {
          isProgrammaticRef.current = false;
        }
      }
      return editor.getModel()?.getValue() ?? null;
    };
    mergeGetRef.current = () => editor.getModel()?.getValue() ?? null;
    mergeApplyRef.current = (merged, programmatic) => {
      const model = editor.getModel();
      if (!model) return null;
      const edits = computeLineEdits(model, merged);
      if (edits.length > 0) {
        if (programmatic) isProgrammaticRef.current = true;
        model.pushEditOperations([], edits, () => []);
        if (programmatic) isProgrammaticRef.current = false;
      }
      return merged; // Monaco round-trips identically
    };

    // Listen for user edits (guarded against programmatic setValue)
    editor.onDidChangeModelContent((e) => {
      setEol(e.eol === "\r\n" ? "CRLF" : "LF");
      if (isProgrammaticRef.current) return;
      lastChangeWasUndo = e.isUndoing || e.isRedoing;
      handleChange(editor.getModel()?.getValue() ?? "");
    });

    // $schema detection for JSON files — debounced to avoid server spam
    const isJsonFile = language === "json";
    let dollarSchemaTimer: ReturnType<typeof setTimeout> | undefined;
    let lastDollarSchema: string | null = null;
    const fileUriStr = uri.toString();

    function detectAndApplyDollarSchema(): void {
      const modelContent = editor.getModel()?.getValue();
      if (!modelContent) return;
      const schemaUrl = extractDollarSchema(modelContent);
      if (schemaUrl === lastDollarSchema) return;
      lastDollarSchema = schemaUrl;

      if (!schemaUrl) {
        removeDollarSchema(fileUriStr);
        return;
      }
      const baseDir = filePath.slice(0, filePath.lastIndexOf("/"));
      // Resolve the $schema URI the same way Monaco's JSON worker does — as a
      // URL relative to the document's file:// URI. The registered schema uri
      // must match exactly, or Monaco can't find the inline schema and emits
      // "No schema request service available".
      const resolvedUrl =
        schemaUrl.startsWith("http://") || schemaUrl.startsWith("https://")
          ? schemaUrl
          : new URL(schemaUrl, `file://${filePath}`).href;
      api.resolveSchema(schemaUrl, baseDir).then((schema) => {
        if (schema) setDollarSchema(fileUriStr, resolvedUrl, schema);
        else removeDollarSchema(fileUriStr);
      });
    }

    // A decision on a schema URL can change what this file's `$schema` resolves to.
    const unsubscribeSchemaConsent = isJsonFile
      ? useSchemaConsentStore.subscribe(() => {
          lastDollarSchema = null;
          detectAndApplyDollarSchema();
        })
      : undefined;

    if (isJsonFile) {
      // Initial detection
      detectAndApplyDollarSchema();
      // Debounced on content change
      editor.onDidChangeModelContent(() => {
        clearTimeout(dollarSchemaTimer);
        dollarSchemaTimer = setTimeout(detectAndApplyDollarSchema, SCHEMA_DETECTION_DELAY_MS);
      });
    }

    // Configured schemas this file matches, and remote schemas a TOML or XML file names.
    requestSchemasForOpenFiles();
    let schemaRequestTimer: ReturnType<typeof setTimeout> | undefined;
    if (language === "toml" || language === "xml") {
      editor.onDidChangeModelContent(() => {
        clearTimeout(schemaRequestTimer);
        schemaRequestTimer = setTimeout(requestSchemasForOpenFiles, SCHEMA_DETECTION_DELAY_MS);
      });
    }

    // Cmd+W is handled by the global keybinding system (useKeybindings).
    // saveOptionsRef is kept in sync with formatting settings above,
    // so save() automatically includes format options for both Cmd+S and auto-save.
    addSaveAction(editor, () => void saveNow());

    // Navigate to initial line:column if provided (e.g. from search results).
    // Only navigate now if diskContent was available at mount (React Query cache hit).
    // If diskContent is null (still fetching), the editor has empty content and Monaco
    // would clamp to line 1 — defer navigation to the effect below.
    let navRafId: number | undefined;
    if (initialLineRef.current && diskContent !== null) {
      navRafId = navigateToInitialPosition(editor);
    } else if (!initialLineRef.current) {
      mountedRef.current = true;
    }

    return () => {
      if (navRafId !== undefined) cancelAnimationFrame(navRafId);
      clearTimeout(dollarSchemaTimer);
      clearTimeout(schemaRequestTimer);
      unsubscribeSchemaConsent?.();
      clearTimeout(inspectTimer);
      cursorDisposable.dispose();
      if (inspectorWidgetRef.current) {
        editor.removeContentWidget(inspectorWidgetRef.current);
        inspectorWidgetRef.current.dispose();
        inspectorWidgetRef.current = null;
      }
      inspectorOpenRef.current = false;
      if (isJsonFile) removeDollarSchema(fileUriStr);
      getSerializedContentRef.current = null;
      mergeGetRef.current = null;
      mergeApplyRef.current = null;
      editorRef.current = null;
      const editorModel = editor.getModel();
      editor.dispose();
      editorModel?.dispose();
    };
    // Mount-only effect
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Update content from disk — only when editor state is clean.
  // Reads state live from the store (not the ref) because useEffect runs after paint,
  // and a keystroke between commit and effect can flip the state to "dirty" while the
  // render-time ref still reports "clean" — that would wipe the user's just-typed char.
  useEffect(() => {
    if (diskContent === null) return;
    if (useEditorStateStore.getState().files.get(filePath)?.state !== "clean") return;
    const model = editorRef.current?.getModel();
    if (model && model.getValue() !== diskContent) {
      isProgrammaticRef.current = true;
      model.setValue(diskContent);
      isProgrammaticRef.current = false;
      setDetectedIndentation(detectIndentation(diskContent));
    }
  }, [diskContent, filePath]);

  // Deferred initial navigation: when diskContent arrives after mount and initial refs are still pending.
  // This handles the case where the editor was created with empty content (diskContent was null
  // during mount) and the mount effect could not navigate. Declared after the content-update effect
  // so React runs them in order — content is set in the model before navigation fires.
  useEffect(() => {
    if (diskContent === null || mountedRef.current) return;
    const editor = editorRef.current;
    if (!editor) return;
    if (!initialLineRef.current) {
      mountedRef.current = true;
      return;
    }
    const rafId = navigateToInitialPosition(editor);
    return () => cancelAnimationFrame(rafId);
  }, [diskContent]);

  // Navigate to line:column when props change (e.g. clicking a different search result for the same file).
  // Skips the initial render — mount-time navigation is handled by the mount effect above.
  useEffect(() => {
    if (!mountedRef.current) return;
    const editor = editorRef.current;
    if (!editor || !line) return;
    editor.revealLineInCenter(line);
    editor.setPosition({ lineNumber: line, column: column ?? 1 });
    editor.focus();
  }, [line, column]);

  // Update language
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    const model = editor.getModel();
    if (model && model.getLanguageId() !== language) {
      monaco.editor.setModelLanguage(model, language);
    }
  }, [language]);

  // Update theme
  useEffect(() => {
    monaco.editor.setTheme(getMonacoThemeName(darkMode));
  }, [darkMode]);

  // Apply indentation live, as its sources change.
  useEffect(() => {
    editorRef.current?.getModel()?.updateOptions(indentation.indentation);
  }, [indentation]);

  useEffect(() => {
    editorRef.current?.updateOptions({
      readOnly: editorConfigPending,
      rulers: rulersFor(editorConfig),
    });
  }, [editorConfigPending, editorConfig]);

  const convertIndentation = useCallback((insertSpaces: boolean) => {
    const editor = editorRef.current;
    const model = editor?.getModel();
    // Monaco's actions do nothing in a read-only editor, so neither does choosing the style.
    if (!editor || !model || editor.getOption(monaco.editor.EditorOption.readOnly)) return;
    // Monaco's actions convert by the model's tab size, then set `insertSpaces` on the model.
    const action = insertSpaces
      ? "editor.action.indentationToSpaces"
      : "editor.action.indentationToTabs";
    void editor.getAction(action)?.run();
    // Keep the sizes the conversion used, whichever source they came from.
    const { tabSize, indentSize } = model.getOptions();
    setFileIndentation({ insertSpaces, tabSize, indentSize });
  }, []);

  // Publish the indentation for the status bar while this is the file's tab.
  const publishedIndentationRef = useRef<EditorIndentation | null>(null);
  useEffect(() => {
    const entry: EditorIndentation = {
      resolution: indentation,
      eol,
      setFileChoice: setFileIndentation,
      convert: convertIndentation,
    };
    publishedIndentationRef.current = entry;
    useEditorIndentationStore.getState().publish(filePath, entry);
  }, [filePath, indentation, eol, convertIndentation]);
  useEffect(
    () => () => {
      const entry = publishedIndentationRef.current;
      if (entry) useEditorIndentationStore.getState().remove(filePath, entry);
    },
    [filePath],
  );

  // Apply TypeScript diagnostics as Monaco markers
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    const model = editor.getModel();
    if (!model) return;

    if (diagnostics.length === 0) {
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

  // Real-time per-file diagnostics are delivered by TypeScript over LSP (via
  // LspDiagnosticsFeature in monaco-lsp-client) — no HTTP round-trip needed.

  // Strict JSON validation — flag comments/trailing commas for files resolved as "json" (not "jsonc")
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    const model = editor.getModel();
    if (!model) return;

    if (resolvedLang !== "json") {
      monaco.editor.setModelMarkers(model, "json-strict", []);
      return;
    }

    const validate = () => {
      const m = editorRef.current?.getModel();
      if (!m) return;
      monaco.editor.setModelMarkers(m, "json-strict", validateStrictJson(m));
    };

    validate();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const disposable = model.onDidChangeContent(() => {
      clearTimeout(timer);
      timer = setTimeout(validate, 500);
    });

    return () => {
      clearTimeout(timer);
      disposable.dispose();
      const m = editorRef.current?.getModel();
      if (m) monaco.editor.setModelMarkers(m, "json-strict", []);
    };
  }, [resolvedLang]);

  // Handlers for diverged state resolution
  const handleAcceptDisk = useCallback(() => {
    const content = hookAcceptDisk();
    if (content === null) return;
    const model = editorRef.current?.getModel();
    if (!model) return;
    isProgrammaticRef.current = true;
    const edits = computeLineEdits(model, content);
    if (edits.length > 0) {
      model.pushEditOperations([], edits, () => []);
    }
    isProgrammaticRef.current = false;
    setDetectedIndentation(detectIndentation(content));
  }, [hookAcceptDisk, isProgrammaticRef]);

  return (
    <div className="flex h-full w-full flex-col overflow-hidden">
      {isDeleted && <DeletedFileBanner onRecreate={recreateFile} />}
      <MovedFileBanner movedFrom={movedFrom} filePath={filePath} panelApi={panelApi} />
      {editorFileState === "diverged" && (
        <ConflictBanner onAcceptDisk={handleAcceptDisk} onKeepMine={handleKeepMine} />
      )}
      {/* min-h-0/min-w-0 let the flex child shrink below Monaco's intrinsic content size;
          without this, the container reports a stale height and Monaco can't re-layout
          when the Dockview panel or window is resized smaller. */}
      <div ref={containerRef} className="min-h-0 min-w-0 flex-1 overflow-hidden" />
    </div>
  );
}
