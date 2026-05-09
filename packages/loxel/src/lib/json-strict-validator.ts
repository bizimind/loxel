/**
 * Strict JSON validation layer. Detects comments and trailing commas in files
 * that should be strict JSON (not JSONC).
 *
 * Monaco's built-in JSON diagnostics are set to permissive mode globally
 * (comments: "ignore", trailingCommas: "ignore"). This module provides
 * supplementary markers for files resolved as strict "json".
 */
import { parse, type ParseError } from "jsonc-parser";
import * as monaco from "monaco-editor";

// ParseErrorCode is a const enum (erased at compile time) — use numeric values.
// See jsonc-parser/lib/esm/main.d.ts for the full list.
const INVALID_COMMENT_TOKEN = 10;
const UNEXPECTED_END_OF_COMMENT = 11;

/** Error key for deduplication: "offset:code" */
function errorKey(e: ParseError): string {
  return `${e.offset}:${e.error}`;
}

function isCommentError(code: number): boolean {
  return code === INVALID_COMMENT_TOKEN || code === UNEXPECTED_END_OF_COMMENT;
}

// ParseErrorCode.ValueExpected = 4 — the code jsonc-parser emits for trailing commas
const VALUE_EXPECTED = 4;

function errorMessage(code: number): string {
  if (isCommentError(code)) return "Comments are not allowed in JSON.";
  if (code === VALUE_EXPECTED) return "Trailing commas are not allowed in JSON.";
  return "Invalid JSON.";
}

/**
 * Validate a JSON model for strict-mode violations (comments and trailing commas).
 * Returns marker data only for JSONC-specific issues — structural errors are
 * already reported by Monaco's built-in JSON validator.
 */
export function validateStrictJson(model: monaco.editor.ITextModel): monaco.editor.IMarkerData[] {
  const content = model.getValue();
  if (!content.trim()) return [];

  // Parse 1: permissive baseline (comments allowed, trailing commas allowed).
  // These are structural errors that Monaco already reports.
  const permissiveErrors: ParseError[] = [];
  parse(content, permissiveErrors, { allowTrailingComma: true });
  const permissiveKeys = new Set(permissiveErrors.map(errorKey));

  // Parse 2: strict (no comments, no trailing commas).
  // Errors present here but NOT in the permissive parse are JSONC-specific violations.
  const strictErrors: ParseError[] = [];
  parse(content, strictErrors, { disallowComments: true, allowTrailingComma: false });

  const markers: monaco.editor.IMarkerData[] = [];
  for (const e of strictErrors) {
    if (permissiveKeys.has(errorKey(e))) continue;

    const startPos = model.getPositionAt(e.offset);
    const endPos = model.getPositionAt(e.offset + e.length);
    markers.push({
      startLineNumber: startPos.lineNumber,
      startColumn: startPos.column,
      endLineNumber: endPos.lineNumber,
      endColumn: endPos.column,
      message: errorMessage(e.error),
      severity: monaco.MarkerSeverity.Error,
      source: "json",
    });
  }

  return markers;
}
