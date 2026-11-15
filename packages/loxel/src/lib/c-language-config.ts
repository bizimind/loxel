import * as monaco from "monaco-editor";

import { frontendLog } from "./frontend-logger";

const log = frontendLog.child("ui");

/** Opens a doc comment, in the Javadoc (`/**`) or Qt (`/*!`) style, not closed on this line. */
const DOC_COMMENT_OPEN = /^\s*\/\*[*!](?!\/)([^*]|\*(?!\/))*$/;

/** Monaco's built-in C-family configuration extended with doc comment behavior. */
export function extendCFamilyConfiguration(
  builtin: monaco.languages.LanguageConfiguration,
): monaco.languages.LanguageConfiguration {
  return {
    ...builtin,
    autoClosingPairs: [
      { open: "/**", close: " */", notIn: ["string"] },
      ...(builtin.autoClosingPairs ?? []),
    ],
    onEnterRules: [
      ...(builtin.onEnterRules ?? []),
      // /** | */
      {
        beforeText: DOC_COMMENT_OPEN,
        afterText: /^\s*\*\/$/,
        action: { indentAction: monaco.languages.IndentAction.IndentOutdent, appendText: " * " },
      },
      // /** ...|
      {
        beforeText: DOC_COMMENT_OPEN,
        action: { indentAction: monaco.languages.IndentAction.None, appendText: " * " },
      },
      //  * ...|
      {
        beforeText: /^(\t| {2})* \*( ([^*]|\*(?!\/))*)?$/,
        // Inside a comment: without this, a wrapped `a\n * b` expression would get a `*` too.
        previousLineText: /^\s*(\/\*|\*( |$))([^*]|\*(?!\/))*$/,
        action: { indentAction: monaco.languages.IndentAction.None, appendText: "* " },
      },
      //  */|
      {
        beforeText: /^(\t| {2})* \*\/\s*$/,
        action: { indentAction: monaco.languages.IndentAction.None, removeText: 1 },
      },
    ],
  };
}

/** Languages whose configuration Monaco registers itself, with the module that holds it. */
const BUILTIN_DEFINITIONS: [
  string,
  () => Promise<{ conf: monaco.languages.LanguageConfiguration }>,
][] = [
  ["c", () => import("monaco-editor/languages/definitions/cpp/cpp.js")],
  ["cpp", () => import("monaco-editor/languages/definitions/cpp/cpp.js")],
  ["objective-c", () => import("monaco-editor/languages/definitions/objective-c/objective-c.js")],
];

/**
 * Registers over Monaco's built-in configuration, the way `python-language-config.ts`
 * does and for the same reason: Monaco registers its own when the first model of a language
 * appears, and the last registration wins, field by field.
 *
 * Resolves once ours is registered, or failed to (logged), for every language.
 */
export async function registerLanguageConfiguration(): Promise<void> {
  await Promise.all(
    BUILTIN_DEFINITIONS.map(
      ([id, loadDefinition]) =>
        new Promise<void>((resolve) => {
          monaco.languages.onLanguageEncountered(id, () => {
            loadDefinition()
              .then(({ conf }) => {
                setTimeout(() => {
                  monaco.languages.setLanguageConfiguration(id, extendCFamilyConfiguration(conf));
                  resolve();
                }, 0);
              })
              .catch((error: unknown) => {
                log.warn("Failed to load Monaco's language definition", { id, error });
                resolve();
              });
          });
        }),
    ),
  );
}
