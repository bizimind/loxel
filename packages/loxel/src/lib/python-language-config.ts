import * as monaco from "monaco-editor";

import { frontendLog } from "./frontend-logger";
import { stepOverTripleQuotesIn } from "./triple-quote-step-over";

const log = frontendLog.child("ui");

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
 * Monaco registers its built-in Python configuration when the first Python model appears, and
 * language configurations merge field by field with the last registration winning, so ours has
 * to land after it. Importing the same module resolves no earlier than Monaco's own loader, and
 * the timeout lets its remaining promise continuations (and its registration) run first.
 *
 * Resolves once ours is registered, or failed to (logged), after the first Python model.
 */
export function registerLanguageConfiguration(): Promise<void> {
  stepOverTripleQuotesIn("python");
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
