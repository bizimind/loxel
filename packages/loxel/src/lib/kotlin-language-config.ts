import * as monaco from "monaco-editor";

import { frontendLog } from "./frontend-logger";

const log = frontendLog.child("ui");

/** A lambda opened on this line whose parameter list ends it, as in `list.map { x ->`. */
const LAMBDA_PARAMETERS_BEFORE = /\{[^{}]*->\s*$/;
/** An open KDoc comment, as in `/** ...` up to the cursor. */
const KDOC_START_BEFORE = /^\s*\/\*\*(?!\/)(?:[^*]|\*(?!\/))*$/;
/** A KDoc body line: its ` * ` sits one space past the comment's indent. */
const KDOC_BODY_BEFORE = /^(?:\t| {2})* \*(?: (?:[^*]|\*(?!\/))*)?$/;
/** A KDoc's last line, with or without text before the closer, one space past the indent. */
const KDOC_END_BEFORE = /^(?:\t| {2})* \*(?:.*\*)?\/\s*$/;

/** Monaco's built-in Kotlin configuration extended with raw strings, backticks and KDoc. */
export function extendKotlinConfiguration(
  builtin: monaco.languages.LanguageConfiguration,
): monaco.languages.LanguageConfiguration {
  const { IndentAction } = monaco.languages;
  return {
    ...builtin,
    autoClosingPairs: [
      // Not `notIn: ["string"]`: Monaco checks the token before the cursor, which after `""` is the
      // empty string's closing quote, so the pair would never fire. Likewise `/*` is already a
      // comment by the time `/**` completes.
      { open: '"""', close: '"""', notIn: ["comment"] },
      { open: "/**", close: " */", notIn: ["string"] },
      { open: '"', close: '"', notIn: ["string"] },
      { open: "'", close: "'", notIn: ["string", "comment"] },
      // KDoc is Markdown, so backticks still pair in comments.
      { open: "`", close: "`", notIn: ["string"] },
      ...(builtin.autoClosingPairs ?? []).filter(({ open }) => open !== '"' && open !== "'"),
    ],
    surroundingPairs: [...(builtin.surroundingPairs ?? []), { open: "`", close: "`" }],
    onEnterRules: [
      ...(builtin.onEnterRules ?? []),
      {
        beforeText: KDOC_START_BEFORE,
        afterText: /^\s*\*\/$/,
        action: { indentAction: IndentAction.IndentOutdent, appendText: " * " },
      },
      {
        beforeText: KDOC_START_BEFORE,
        action: { indentAction: IndentAction.None, appendText: " * " },
      },
      {
        beforeText: KDOC_BODY_BEFORE,
        action: { indentAction: IndentAction.None, appendText: "* " },
      },
      { beforeText: KDOC_END_BEFORE, action: { indentAction: IndentAction.None, removeText: 1 } },
      // Monaco's bracket handling only indents right after the `{`.
      {
        beforeText: LAMBDA_PARAMETERS_BEFORE,
        afterText: /^\s*\}/,
        action: { indentAction: IndentAction.IndentOutdent },
      },
      { beforeText: LAMBDA_PARAMETERS_BEFORE, action: { indentAction: IndentAction.Indent } },
    ],
  };
}

/**
 * Monaco registers its built-in Kotlin configuration when the first Kotlin model appears, and
 * language configurations merge field by field with the last registration winning, so ours has
 * to land after it. Importing the same module resolves no earlier than Monaco's own loader, and
 * the timeout lets its remaining promise continuations (and its registration) run first.
 *
 * Resolves once ours is registered, or failed to (logged), after the first Kotlin model.
 */
export function registerLanguageConfiguration(): Promise<void> {
  return new Promise((resolve) => {
    monaco.languages.onLanguageEncountered("kotlin", () => {
      import("monaco-editor/languages/definitions/kotlin/kotlin.js")
        .then(({ conf }) => {
          setTimeout(() => {
            monaco.languages.setLanguageConfiguration("kotlin", extendKotlinConfiguration(conf));
            resolve();
          }, 0);
        })
        .catch((error: unknown) => {
          log.warn("Failed to load Monaco's Kotlin language definition", { error });
          resolve();
        });
    });
  });
}
