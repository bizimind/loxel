import * as monaco from "monaco-editor";
import { conf as typescriptConf } from "monaco-editor/languages/definitions/typescript/typescript.js";

import { frontendLog } from "./frontend-logger";

const log = frontendLog.child("ui");

/** Monaco's built-in Java configuration extended with Javadoc, text-block and indent behavior. */
export function extendJavaConfiguration(
  builtin: monaco.languages.LanguageConfiguration,
): monaco.languages.LanguageConfiguration {
  return {
    ...builtin,
    autoClosingPairs: [
      ...(builtin.autoClosingPairs ?? []).filter(({ open }) => open !== '"' && open !== "'"),
      // Not `notIn: ["string"]`: Monaco checks the token before the cursor, which after `""` is the
      // empty string's closing quote, so the pair would never fire.
      { open: '"""', close: '"""', notIn: ["comment"] },
      { open: "/**", close: " */", notIn: ["string"] },
      { open: '"', close: '"', notIn: ["string"] },
      { open: "'", close: "'", notIn: ["string", "comment"] },
    ],
    // Monaco strips brackets inside string and comment tokens before matching these. Braces only:
    // these rules see one line at a time, and a call continued as `g(a,` / `b);` closes its paren
    // mid-line, so counting parens would push every line after it one level too deep.
    indentationRules: {
      increaseIndentPattern: /^.*\{[^}]*$/,
      decreaseIndentPattern: /^\s*\}.*$/,
      // Comment continuation lines are off the indent grid by one space and say nothing about it.
      unIndentedLinePattern:
        /^(?:\t| )* \*[^/]*\*\/\s*$|^(?:\t| )* \*\/\s*$|^(?:\t| )* \*(?: .*)?$/,
    },
    onEnterRules: [
      ...(builtin.onEnterRules ?? []),
      ...(typescriptConf.onEnterRules ?? []),
      {
        // e.g. /* ...| (the TypeScript rules only start a comment from `/**`)
        beforeText: /^\s*\/\*(?!\*)(?:[^*]|\*(?!\/))*$/,
        action: { indentAction: monaco.languages.IndentAction.None, appendText: " * " },
      },
      {
        // e.g. """|""": the closing delimiter stays at the content's indent, since Java strips the
        // indent they share and a closing delimiter further left would keep it in the string.
        beforeText: /"""$/,
        afterText: /^"""/,
        action: { indentAction: monaco.languages.IndentAction.Indent },
      },
    ],
  };
}

/**
 * What typing a `"` after `textBefore` (the document up to the cursor) should do when it completes
 * a closing `"""`, or null when it does not: `collapse` when a delimiter already starts at the
 * cursor (`textAfter` is the rest of its line), `insert` when none follows.
 */
export function closingTextBlockAction(
  textBefore: string,
  textAfter: string,
): "collapse" | "insert" | null {
  if (!/(?:^|[^"\\])""$/.test(textBefore)) return null;
  // Java strings only span lines as text blocks, so an odd count of delimiters means inside one.
  // A `"""` in a comment or a one-line string can miscount, which only falls back to Monaco's typing.
  if ((textBefore.match(/(?<!\\)"""/g)?.length ?? 0) % 2 === 0) return null;
  if (/^"""(?!")/.test(textAfter)) return "collapse";
  return textAfter.startsWith('"') ? null : "insert";
}

/**
 * Java text blocks span lines, so the cursor reaches the closing delimiter at its start, where
 * Monaco no longer overtypes it and the keydown hook in `python-language-config.ts` does not apply.
 * Without this, typing `"""` to close one would leave six quotes, and on a block with no closing
 * delimiter the `"""` pair would add a second one.
 */
function closeTextBlocks(editor: monaco.editor.ICodeEditor): void {
  editor.onKeyDown((e) => {
    if (e.browserEvent.key !== '"') return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (editor.getOption(monaco.editor.EditorOption.readOnly)) return;
    const model = editor.getModel();
    const selections = editor.getSelections();
    if (model?.getLanguageId() !== "java" || selections?.length !== 1) return;
    const [selection] = selections;
    if (!selection?.isEmpty()) return;
    const { lineNumber, column } = selection.getPosition();
    const textBefore = model.getValueInRange(new monaco.Range(1, 1, lineNumber, column));
    const action = closingTextBlockAction(
      textBefore,
      model.getLineContent(lineNumber).slice(column - 1),
    );
    if (!action) return;
    e.preventDefault();
    e.stopPropagation();
    const cursor = (offset: number) =>
      new monaco.Selection(lineNumber, column + offset, lineNumber, column + offset);
    if (action === "insert") {
      editor.executeEdits("java-text-block", [{ range: selection, text: '"' }], [cursor(1)]);
      return;
    }
    const typed = new monaco.Range(lineNumber, column - 2, lineNumber, column);
    editor.executeEdits("java-text-block", [{ range: typed, text: "" }], [cursor(1)]);
  });
}

/**
 * Monaco registers its built-in Java configuration when the first Java model appears, and language
 * configurations merge field by field with the last registration winning, so ours has to land
 * after it. Importing the same module resolves no earlier than Monaco's own loader, and the timeout
 * lets its remaining promise continuations (and its registration) run first.
 *
 * Resolves once ours is registered, or failed to (logged), after the first Java model.
 */
export function registerLanguageConfiguration(): Promise<void> {
  monaco.editor.onDidCreateEditor(closeTextBlocks);
  return new Promise((resolve) => {
    monaco.languages.onLanguageEncountered("java", () => {
      import("monaco-editor/languages/definitions/java/java.js")
        .then(({ conf }) => {
          setTimeout(() => {
            monaco.languages.setLanguageConfiguration("java", extendJavaConfiguration(conf));
            resolve();
          }, 0);
        })
        .catch((error: unknown) => {
          log.warn("Failed to load Monaco's Java language definition", { error });
          resolve();
        });
    });
  });
}
