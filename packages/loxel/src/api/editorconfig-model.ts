/**
 * The `.editorconfig` properties Loxel applies, resolved for one file. A property no section set
 * (or one set to `unset`) is absent.
 */
export interface EditorConfigProperties {
  indentStyle?: "space" | "tab";
  /** Columns per indentation level; absent for `indent_size = tab` without a `tab_width`. */
  indentSize?: number;
  /** Columns a tab character is displayed as; defaults to a numeric `indent_size`. */
  tabWidth?: number;
  /** Column the editor shows a ruler at; absent for `off`. */
  maxLineLength?: number;
  /** Line endings to save with. `cr` is not supported by the editor and is dropped. */
  endOfLine?: "lf" | "crlf";
  insertFinalNewline?: boolean;
  trimTrailingWhitespace?: boolean;
}

/** `GET /api/editorconfig?path=&wt=` response; empty for files outside a worktree or Others folder. */
export interface EditorConfigResponse {
  properties: EditorConfigProperties;
}
