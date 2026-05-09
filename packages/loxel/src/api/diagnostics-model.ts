export interface TsgoDiagnostic {
  /** Relative file path from repo root */
  file: string;
  /** 1-indexed line number */
  line: number;
  /** 1-indexed column number */
  col: number;
  severity: "error" | "warning";
  /** TS error code, e.g. 2307 */
  code: number;
  message: string;
}

/** Per-file diagnostic from the TypeScript LanguageService (supports in-memory content). */
export interface FileDiagnostic {
  /** 1-indexed start line */
  line: number;
  /** 1-indexed start column */
  col: number;
  /** 1-indexed end line */
  endLine: number;
  /** 1-indexed end column */
  endCol: number;
  severity: "error" | "warning" | "suggestion";
  /** TS error code, e.g. 2307 */
  code: number;
  message: string;
}
