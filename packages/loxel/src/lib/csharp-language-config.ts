import * as monaco from "monaco-editor";
import { conf as typescriptConf } from "monaco-editor/languages/definitions/typescript/typescript.js";

import { frontendLog } from "./frontend-logger";
import { stepOverTripleQuotesIn } from "./python-language-config";

const log = frontendLog.child("ui");

/** A `///` doc comment line, but not `////`, which the compiler treats as a plain comment. */
export const CSHARP_DOC_COMMENT_LINE = /^\s*\/\/\/(?!\/)/;

/** Monaco's built-in C# configuration extended with doc comment and raw string behavior. */
export function extendCsharpConfiguration(
  builtin: monaco.languages.LanguageConfiguration,
): monaco.languages.LanguageConfiguration {
  return {
    ...builtin,
    // Not `notIn: ["string"]`: Monaco checks the token before the cursor, which after `""` is the
    // empty string's closing quote, so the pair would never fire.
    autoClosingPairs: [
      { open: '"""', close: '"""', notIn: ["comment"] },
      ...(builtin.autoClosingPairs ?? []),
    ],
    onEnterRules: [
      ...(builtin.onEnterRules ?? []),
      // A raw string's closing delimiter has to be on a line of its own.
      {
        beforeText: /"""$/,
        afterText: /^"""/,
        action: { indentAction: monaco.languages.IndentAction.IndentOutdent },
      },
      // `/** */` comments have the same syntax as JSDoc, so its continuation rules apply as is.
      ...(typescriptConf.onEnterRules ?? []),
      {
        beforeText: CSHARP_DOC_COMMENT_LINE,
        action: { indentAction: monaco.languages.IndentAction.None, appendText: "/// " },
      },
    ],
  };
}

/** Monaco's built-in Razor configuration, which only knows HTML comments, extended with Razor's. */
export function extendRazorConfiguration(
  builtin: monaco.languages.LanguageConfiguration,
): monaco.languages.LanguageConfiguration {
  return {
    ...builtin,
    // `@* *@` is valid in both markup and code blocks, where `<!-- -->` is not.
    comments: { blockComment: ["@*", "*@"] },
    brackets: [...(builtin.brackets ?? []), ["[", "]"]],
    surroundingPairs: [
      { open: "{", close: "}" },
      { open: "[", close: "]" },
      { open: "(", close: ")" },
      ...(builtin.surroundingPairs ?? []),
    ],
  };
}

/** Internal model surface (not in monaco.d.ts), the token types Monaco's own `notIn` reads. */
interface InternalTextModel {
  tokenization: {
    getLineTokens(lineNumber: number): {
      findTokenIndexAtOffset(offset: number): number;
      getStandardTokenType(tokenIndex: number): number;
    };
  };
}

/** `StandardTokenType.String`, which monaco.d.ts does not export. */
const STRING_TOKEN_TYPE = 2;

/**
 * Whether a `"` typed at `position` continues an open string, as in `@"say ""hi"""` or the closing
 * delimiter of a multi-line raw string, where the `"""` pair would add three stray quotes. Monaco's
 * `notIn` cannot tell, as it reads the token just before the cursor, so this reads the one before
 * the run of quotes, and before any `$` or `@`, which are colored as part of the string they open.
 */
export function isQuoteInsideOpenString(
  model: monaco.editor.ITextModel,
  { lineNumber, column }: monaco.IPosition,
): boolean {
  const line = model.getLineContent(lineNumber);
  if (line[column - 1] === '"') return false;
  const start = line.slice(0, column - 1).search(/[$@]*""+$/);
  if (start < 1) return false;
  const tokens = (model as unknown as InternalTextModel).tokenization.getLineTokens(lineNumber);
  return (
    tokens.getStandardTokenType(tokens.findTokenIndexAtOffset(start - 1)) === STRING_TOKEN_TYPE
  );
}

/** Inserts just the quote where the `"""` pair would otherwise add three stray ones. */
function keepEscapedQuotesPlain(editor: monaco.editor.ICodeEditor): void {
  editor.onKeyDown((e) => {
    if (e.browserEvent.key !== '"' || e.ctrlKey || e.metaKey || e.altKey) return;
    if (editor.getOption(monaco.editor.EditorOption.readOnly)) return;
    const model = editor.getModel();
    const selections = editor.getSelections();
    if (model?.getLanguageId() !== "csharp" || selections?.length !== 1) return;
    const [selection] = selections;
    if (!selection?.isEmpty()) return;
    if (!isQuoteInsideOpenString(model, selection.getPosition())) return;
    e.preventDefault();
    e.stopPropagation();
    editor.executeEdits("keyboard", [{ range: selection, text: '"', forceMoveMarkers: true }]);
  });
}

/**
 * Monaco registers a built-in configuration when the first model of its language appears, and
 * language configurations merge field by field with the last registration winning, so ours has to
 * land after it. Importing the same module resolves no earlier than Monaco's own loader, and the
 * timeout lets its remaining promise continuations (and its registration) run first.
 *
 * Resolves once ours is registered, or failed to (logged), after the first model of the language.
 */
function extendAfterBuiltin(
  languageId: string,
  loadBuiltin: () => Promise<{ conf: monaco.languages.LanguageConfiguration }>,
  extend: (
    builtin: monaco.languages.LanguageConfiguration,
  ) => monaco.languages.LanguageConfiguration,
): Promise<void> {
  return new Promise((resolve) => {
    monaco.languages.onLanguageEncountered(languageId, () => {
      loadBuiltin()
        .then(({ conf }) => {
          setTimeout(() => {
            monaco.languages.setLanguageConfiguration(languageId, extend(conf));
            resolve();
          }, 0);
        })
        .catch((error: unknown) => {
          log.warn("Failed to load Monaco's language definition", { languageId, error });
          resolve();
        });
    });
  });
}

/** Resolves once both languages have a model and their configurations are registered. */
export async function registerLanguageConfiguration(): Promise<void> {
  stepOverTripleQuotesIn("csharp");
  monaco.editor.onDidCreateEditor(keepEscapedQuotesPlain);
  await Promise.all([
    extendAfterBuiltin(
      "csharp",
      () => import("monaco-editor/languages/definitions/csharp/csharp.js"),
      extendCsharpConfiguration,
    ),
    extendAfterBuiltin(
      "razor",
      () => import("monaco-editor/languages/definitions/razor/razor.js"),
      extendRazorConfiguration,
    ),
  ]);
}
