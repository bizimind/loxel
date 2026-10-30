import * as monaco from "monaco-editor";

import { frontendLog } from "./frontend-logger";

const log = frontendLog.child("ui");

/** Languages whose configuration auto-closes `"""` / `'''` (TOML's is set in `monaco-languages.ts`). */
const TRIPLE_QUOTE_LANGUAGES = new Set(["python", "toml"]);

/**
 * Enter after a block-ending statement dedents the next line. Lines whose code (before any
 * comment) continues onto the next one are excluded: ending in an open bracket, a comma, a
 * backslash, a binary operator, a colon or an opening triple quote.
 */
export const PYTHON_DEDENT_AFTER =
  /^\s+(?:pass|break|continue|raise|return)\b(?![^#]*(?:[([{,\\+\-*/%&|^<>=.@:]|"""|''')\s*(?:#.*)?$).*$/;

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
        // Only at end of line: Monaco matches `beforeText` up to the cursor, so without this an
        // Enter mid-statement would outdent the rest of the line.
        afterText: /^\s*$/,
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

/**
 * Monaco registers its built-in Python configuration when the first Python model appears, and
 * language configurations merge field by field with the last registration winning, so ours has
 * to land after it. Importing the same module resolves no earlier than Monaco's own loader, and
 * the timeout lets its remaining promise continuations (and its registration) run first.
 *
 * Resolves once ours is registered, or failed to (logged), after the first Python model.
 */
export function registerPythonLanguageConfiguration(): Promise<void> {
  monaco.editor.onDidCreateEditor(overtypeTripleQuotes);
  return new Promise((resolve) => {
    monaco.languages.onLanguageEncountered("python", () => {
      import("monaco-editor/languages/definitions/python/python.js")
        .then(({ conf }) => {
          setTimeout(() => {
            monaco.languages.setLanguageConfiguration("python", extendPythonConfiguration(conf));
            resolve();
          }, 0);
        })
        .catch((error: unknown) => {
          log.warn("Failed to load Monaco's Python language definition", { error });
          resolve();
        });
    });
  });
}
