import * as monaco from "monaco-editor";

import { frontendLog } from "./frontend-logger";

const log = frontendLog.child("ui");

/** What auto-closing a block doc comment inserts. */
const BLOCK_COMMENT_CLOSE = " */";

/** Text after `/**` or `/*!` on a line, up to a cursor that is still inside the comment. */
const BLOCK_COMMENT_BODY = String.raw`(?:[^*]|\*(?!\/))*`;

/** A `///` doc comment line, excluding `////`, which Rust treats as a plain comment. */
export const RUST_OUTER_DOC_LINE = /^\s*\/\/\/(?!\/).*$/;

/** A `//!` inner doc comment line. */
export const RUST_INNER_DOC_LINE = /^\s*\/\/!.*$/;

/** An open `/**` or `/*!` block doc comment, excluding the empty comment `/**\/`. */
export const RUST_BLOCK_DOC_START = new RegExp(
  String.raw`^\s*\/\*[*!](?!\/)${BLOCK_COMMENT_BODY}$`,
);

/**
 * A ` * ` continuation line. Its star sits one space past the comment's indent, so rustfmt's
 * operator lines at an even indent (`    * factor`) never match, and `RUST_BLOCK_DOC_PREVIOUS`
 * guards the rest.
 */
export const RUST_BLOCK_DOC_CONTINUATION = new RegExp(
  String.raw`^(?:\t| {2})* \*(?: ${BLOCK_COMMENT_BODY})?$`,
);

/** The line above a continuation line: the start of the comment or an earlier continuation. */
export const RUST_BLOCK_DOC_PREVIOUS = /^\s*(?:\/\*[*!]|\*(?!\/))(?!.*\*\/)/;

/** Monaco's built-in Rust configuration extended with doc comment editing and region folding. */
export function extendRustConfiguration(
  builtin: monaco.languages.LanguageConfiguration,
): monaco.languages.LanguageConfiguration {
  const { None, IndentOutdent } = monaco.languages.IndentAction;
  return {
    ...builtin,
    // No `'`: it would fire on every lifetime. Not `notIn: ["comment"]` on the block comments:
    // Monaco checks the token before the cursor, which after `/*` is already a comment.
    autoClosingPairs: [
      ...(builtin.autoClosingPairs ?? []),
      { open: "/**", close: BLOCK_COMMENT_CLOSE, notIn: ["string"] },
      { open: "/*!", close: BLOCK_COMMENT_CLOSE, notIn: ["string"] },
      { open: "`", close: "`", notIn: ["string"] },
    ],
    surroundingPairs: [
      ...(builtin.surroundingPairs ?? []),
      { open: "`", close: "`" },
      { open: "<", close: ">" },
    ],
    // Monaco's built-in markers are C's `#pragma region`.
    folding: { markers: { start: /^\s*\/\/\s*region\b/, end: /^\s*\/\/\s*endregion\b/ } },
    onEnterRules: [
      ...(builtin.onEnterRules ?? []),
      { beforeText: RUST_OUTER_DOC_LINE, action: { indentAction: None, appendText: "/// " } },
      { beforeText: RUST_INNER_DOC_LINE, action: { indentAction: None, appendText: "//! " } },
      {
        beforeText: RUST_BLOCK_DOC_START,
        afterText: /^\s*\*\/$/,
        action: { indentAction: IndentOutdent, appendText: " * " },
      },
      { beforeText: RUST_BLOCK_DOC_START, action: { indentAction: None, appendText: " * " } },
      {
        beforeText: RUST_BLOCK_DOC_CONTINUATION,
        previousLineText: RUST_BLOCK_DOC_PREVIOUS,
        action: { indentAction: None, appendText: "* " },
      },
      // Back to the comment's indent after its closing line.
      {
        beforeText: /^(?:\t| {2})* \*(?:.*\*)?\/\s*$/,
        action: { indentAction: None, removeText: 1 },
      },
    ],
  };
}

/** An open block doc comment whose text ends in the `*` of a closing `*\/` being typed. */
const BLOCK_DOC_BEFORE_CLOSE = /\/\*(?:\*|[*!].*\*)$/;

/**
 * Monaco overtypes only the first character of a multi-character auto-closed pair, so finishing an
 * auto-closed `/** Doc. *\/` by hand would leave a second ` *\/` behind. The `/` that ends the
 * comment takes the auto-closed one with it.
 */
function overtypeBlockCommentClose(editor: monaco.editor.ICodeEditor): void {
  editor.onKeyDown((e) => {
    if (e.browserEvent.key !== "/") return;
    if (e.ctrlKey || e.metaKey || e.altKey || e.browserEvent.isComposing) return;
    if (editor.getOption(monaco.editor.EditorOption.readOnly)) return;
    const model = editor.getModel();
    const selections = editor.getSelections();
    if (model?.getLanguageId() !== "rust" || selections?.length !== 1) return;
    const [selection] = selections;
    if (!selection?.isEmpty()) return;
    const { lineNumber, column } = selection.getPosition();
    const line = model.getLineContent(lineNumber);
    const before = line.slice(0, column - 1);
    if (!BLOCK_DOC_BEFORE_CLOSE.test(before)) return;
    if (!line.slice(column - 1).startsWith(BLOCK_COMMENT_CLOSE)) return;
    e.preventDefault();
    e.stopPropagation();
    const end = column + 1;
    editor.executeEdits(
      "rust-block-comment-close",
      [
        {
          range: new monaco.Range(
            lineNumber,
            column,
            lineNumber,
            column + BLOCK_COMMENT_CLOSE.length,
          ),
          text: "/",
        },
      ],
      [new monaco.Selection(lineNumber, end, lineNumber, end)],
    );
  });
}

/**
 * Monaco registers its built-in Rust configuration when the first Rust model appears, and language
 * configurations merge field by field with the last registration winning, so ours has to land
 * after it. See `python-language-config.ts` for why the import and timeout ensure that.
 *
 * Resolves once ours is registered, or failed to (logged), after the first Rust model.
 */
export function registerLanguageConfiguration(): Promise<void> {
  monaco.editor.onDidCreateEditor(overtypeBlockCommentClose);
  return new Promise((resolve) => {
    monaco.languages.onLanguageEncountered("rust", () => {
      import("monaco-editor/languages/definitions/rust/rust.js")
        .then(({ conf }) => {
          setTimeout(() => {
            monaco.languages.setLanguageConfiguration("rust", extendRustConfiguration(conf));
            resolve();
          }, 0);
        })
        .catch((error: unknown) => {
          log.warn("Failed to load Monaco's Rust language definition", { error });
          resolve();
        });
    });
  });
}
