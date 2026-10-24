import * as monaco from "monaco-editor";

/**
 * Enter after a block-ending statement dedents the next line. Lines that continue onto the
 * next one (ending in an open bracket, a comma or a backslash) are excluded.
 */
export const PYTHON_DEDENT_AFTER =
  /^\s+(?:pass|break|continue|raise|return)\b(?!.*[([{,\\]\s*(?:#.*)?$).*$/;

/** Monaco's built-in Python configuration extended with docstring and dedent behavior. */
export function extendPythonConfiguration(
  builtin: monaco.languages.LanguageConfiguration,
): monaco.languages.LanguageConfiguration {
  return {
    ...builtin,
    // Not `notIn: ["string"]`: Monaco checks the token before the cursor, which after `""` is the
    // empty string's closing quote, so the pair would never fire.
    autoClosingPairs: [
      { open: '"""', close: '"""', notIn: ["comment"] },
      { open: "'''", close: "'''", notIn: ["comment"] },
      ...(builtin.autoClosingPairs ?? []),
    ],
    onEnterRules: [
      ...(builtin.onEnterRules ?? []),
      {
        beforeText: PYTHON_DEDENT_AFTER,
        action: { indentAction: monaco.languages.IndentAction.Outdent },
      },
    ],
  };
}

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
 * Monaco overtypes only the first character of a multi-character auto-closed pair, so typing the
 * closing `"""` of an auto-closed docstring would leave two stray quotes. Step over the rest of a
 * triple-quote delimiter instead, which also covers closing quotes Monaco never auto-inserted.
 */
function overtypeTripleQuotes(editor: monaco.editor.ICodeEditor): void {
  editor.onKeyDown((e) => {
    const quote = e.browserEvent.key;
    if (quote !== '"' && quote !== "'") return;
    const model = editor.getModel();
    const selections = editor.getSelections();
    if (model?.getLanguageId() !== "python" || selections?.length !== 1) return;
    const [selection] = selections;
    if (!selection?.isEmpty()) return;
    const { lineNumber, column } = selection.getPosition();
    if (!isInsideTripleQuote(model.getLineContent(lineNumber), column, quote)) return;
    e.preventDefault();
    e.stopPropagation();
    editor.setPosition({ lineNumber, column: column + 1 });
  });
}

/**
 * Monaco registers its built-in Python configuration when the first Python model appears, and
 * language configurations merge field by field with the last registration winning, so ours has
 * to land after it. Importing the same module resolves no earlier than Monaco's own loader, and
 * the timeout lets its remaining promise continuations (and its registration) run first.
 */
export function registerPythonLanguageConfiguration(): void {
  monaco.editor.onDidCreateEditor(overtypeTripleQuotes);
  monaco.languages.onLanguageEncountered("python", () => {
    import("monaco-editor/languages/definitions/python/python.js")
      .then(({ conf }) => {
        setTimeout(() => {
          monaco.languages.setLanguageConfiguration("python", extendPythonConfiguration(conf));
        }, 0);
      })
      .catch((err: unknown) => {
        console.warn("[python-language-config] Failed to load Monaco's Python definition:", err);
      });
  });
}
