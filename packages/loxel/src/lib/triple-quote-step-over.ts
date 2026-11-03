import * as monaco from "monaco-editor";

/** Languages whose configuration auto-closes `"""` or `'''`, added by {@link stepOverTripleQuotesIn}. */
const TRIPLE_QUOTE_LANGUAGES = new Set<string>();

/**
 * Whether `column` sits strictly inside a run of exactly three `quote` characters, i.e. within a
 * triple-quote delimiter. Typing another `quote` there would only make a stray fourth quote.
 */
export function isInsideTripleQuote(line: string, column: number, quote: string): boolean {
  const offset = column - 1;
  let start = offset;
  while (start > 0 && line[start - 1] === quote) start -= 1;
  let end = offset;
  while (end < line.length && line[end] === quote) end += 1;
  return start < offset && offset < end && end - start === 3;
}

/**
 * Adds a language, whose configuration auto-closes `"""` or `'''`, to the step-over below. The
 * first call installs it on every editor created from then on, so call it while registering the
 * language's configuration, before any editor exists.
 */
export function stepOverTripleQuotesIn(language: string): void {
  if (TRIPLE_QUOTE_LANGUAGES.size === 0) monaco.editor.onDidCreateEditor(overtypeTripleQuotes);
  TRIPLE_QUOTE_LANGUAGES.add(language);
}

/**
 * Monaco overtypes only the first character of a multi-character auto-closed pair, so typing the
 * closing `"""` of an auto-closed docstring would leave two stray quotes. Step over the rest of a
 * triple-quote delimiter instead, which also covers closing quotes Monaco never auto-inserted.
 */
function overtypeTripleQuotes(editor: monaco.editor.ICodeEditor): void {
  editor.onKeyDown((e) => {
    const quote = e.browserEvent.key;
    if (quote !== '"' && quote !== "'") return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (editor.getOption(monaco.editor.EditorOption.readOnly)) return;
    const model = editor.getModel();
    const selections = editor.getSelections();
    if (!model || !TRIPLE_QUOTE_LANGUAGES.has(model.getLanguageId())) return;
    if (selections?.length !== 1) return;
    const [selection] = selections;
    if (!selection?.isEmpty()) return;
    const { lineNumber, column } = selection.getPosition();
    if (!isInsideTripleQuote(model.getLineContent(lineNumber), column, quote)) return;
    e.preventDefault();
    e.stopPropagation();
    editor.setPosition({ lineNumber, column: column + 1 });
  });
}
