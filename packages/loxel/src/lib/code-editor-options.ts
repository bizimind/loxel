import type { editor as monacoEditor } from "monaco-editor";

/** The options every editor tab shares, whatever it shows. */
export const CODE_EDITOR_OPTIONS = {
  // Editor-level tabSize/insertSpaces are global in standalone Monaco: setting them would reset
  // every open model's indentation. Indentation is set per model; this constant flag only keeps
  // Monaco from overriding it.
  detectIndentation: false,
  minimap: { enabled: false },
  scrollBeyondLastLine: false,
  // Fixed whatever the font size; the code font's size bounds keep text within it.
  lineHeight: 22,
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
} as const satisfies monacoEditor.IStandaloneEditorConstructionOptions;
