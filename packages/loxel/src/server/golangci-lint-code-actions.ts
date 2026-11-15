/**
 * Quick fixes for golangci-lint's diagnostics: the linter's own suggested fixes, and `//nolint` for
 * one line. Everything here is computed against `checked`, the bytes the diagnostics were reported
 * on, so the caller offers the result only while the buffer still holds exactly those bytes, and
 * each edit names that buffer's version, so the client refuses it once the buffer has moved on.
 */
import { isUtf8 } from "node:buffer";

import { z } from "zod";

import type { GolangciLintDiagnostic } from "./golangci-lint-diagnostics";

type LspRange = GolangciLintDiagnostic["range"];
type LspPosition = LspRange["start"];

interface LspTextEdit {
  range: LspRange;
  newText: string;
}

export interface GolangciLintCodeAction {
  title: string;
  kind: "quickfix";
  diagnostics: GolangciLintDiagnostic[];
  edit: {
    documentChanges: { textDocument: { uri: string; version: number }; edits: LspTextEdit[] }[];
  };
}

/** golangci-lint's JSON for one fix: byte offsets into the file, and `NewText` as base64 or null. */
const SuggestedFixSchema = z.object({
  Message: z.string().nullish(),
  TextEdits: z.array(
    z.object({
      Pos: z.number().int().nonnegative(),
      End: z.number().int().nonnegative(),
      NewText: z.string().nullish(),
    }),
  ),
});

type SuggestedFix = z.infer<typeof SuggestedFixSchema>;

const WHITESPACE_RUN = /\s+/g;
const NOLINT_DIRECTIVE = /^nolint(?: |:|$)/;
const COMMENT_LEAD = /^[/ ]*/;

/** Whether `a` and `b` share a position, an end touching a start included. */
export function rangesTouch(a: LspRange, b: LspRange): boolean {
  return !isBefore(a.end, b.start) && !isBefore(b.end, a.start);
}

/**
 * The fixes for `diagnostics`, then `//nolint` for their lines, one action for each that differs. No
 * action is preferred: a linter's fix can be wrong, so applying one is always the user's choice.
 */
export function golangciLintCodeActions(
  document: { uri: string; version: number },
  checked: Buffer,
  diagnostics: readonly GolangciLintDiagnostic[],
): GolangciLintCodeAction[] {
  const actions = new Map<string, GolangciLintCodeAction>();
  const add = (title: string, diagnostic: GolangciLintDiagnostic, edits: LspTextEdit[]): void => {
    const key = JSON.stringify([title, edits]);
    if (actions.has(key)) return;
    actions.set(key, {
      title,
      kind: "quickfix",
      diagnostics: [diagnostic],
      edit: { documentChanges: [{ textDocument: document, edits }] },
    });
  };
  for (const diagnostic of diagnostics) {
    for (const raw of diagnostic.data?.suggestedFixes ?? []) {
      const fix = SuggestedFixSchema.safeParse(raw);
      const edits = fix.success ? fixEdits(checked, fix.data) : null;
      if (fix.success && edits) add(fixTitle(diagnostic.code, fix.data), diagnostic, edits);
    }
  }
  const text = checked.toString("utf8");
  for (const diagnostic of diagnostics) {
    const edit = nolintEdit(text, diagnostic.range.start.line, diagnostic.code);
    if (edit) add(`${diagnostic.code}: Disable for this line`, diagnostic, [edit]);
  }
  return [...actions.values()];
}

/**
 * The edit that makes `//nolint` on `line` name `linter`, or null when none would apply. golangci-lint
 * reads only a comment that starts with the directive, so one goes before an ordinary comment there.
 * A line ending inside a raw string or block comment would take it as text, and on a line of its own
 * it would cover the next statement instead.
 */
export function nolintEdit(text: string, line: number, linter: string): LspTextEdit | null {
  const shape = scanLine(text, line);
  if (!shape) return null;
  const insert = (index: number, newText: string): LspTextEdit => {
    const position = { line, character: index - shape.start };
    return { range: { start: position, end: position }, newText };
  };
  if (shape.comment === null) return insert(shape.end, ` //nolint:${linter}`);
  const comment = text.slice(shape.comment, shape.end);
  const lead = COMMENT_LEAD.exec(comment)?.[0].length ?? 0;
  const body = comment.slice(lead);
  if (!NOLINT_DIRECTIVE.test(body)) return insert(shape.comment, `//nolint:${linter} `);
  // The rest of the rules are the parser's: no list covers everything, and `//` ends the list.
  if (!body.startsWith("nolint:") || body.startsWith("nolint:all")) return null;
  const list = (body.split("//", 1)[0] ?? "").trimEnd();
  const names = list.slice("nolint:".length).split(",");
  const named = names.map((name) => name.trim().toLowerCase());
  if (named.includes("all") || named.includes(linter)) return null;
  return insert(shape.comment + lead + list.length, `,${linter}`);
}

function isBefore(a: LspPosition, b: LspPosition): boolean {
  return a.line < b.line || (a.line === b.line && a.character < b.character);
}

function fixTitle(linter: string, fix: SuggestedFix): string {
  const message = fix.Message?.replace(WHITESPACE_RUN, " ").trim();
  return message ? `${linter}: ${message}` : `Apply ${linter} fix`;
}

/** `fix` as language-server edits on `checked`, or null when it doesn't fit those bytes. */
function fixEdits(checked: Buffer, fix: SuggestedFix): LspTextEdit[] | null {
  if (fix.TextEdits.length === 0) return null;
  const sorted = fix.TextEdits.toSorted((a, b) => a.Pos - b.Pos || a.End - b.End);
  const edits: LspTextEdit[] = [];
  let previousEnd = 0;
  for (const { Pos, End, NewText } of sorted) {
    if (Pos < previousEnd || End < Pos || !isCharBoundary(checked, Pos)) return null;
    if (!isCharBoundary(checked, End)) return null;
    const replacement = Buffer.from(NewText ?? "", "base64");
    if (!isUtf8(replacement)) return null;
    previousEnd = End;
    edits.push({
      range: { start: utf16Position(checked, Pos), end: utf16Position(checked, End) },
      newText: replacement.toString("utf8"),
    });
  }
  return edits;
}

/** Whether byte `offset` is inside `bytes` and not within a UTF-8 sequence. */
function isCharBoundary(bytes: Buffer, offset: number): boolean {
  if (offset > bytes.length) return false;
  const byte = bytes[offset];
  return byte === undefined || (byte & 0xc0) !== 0x80;
}

function utf16Position(bytes: Buffer, offset: number): LspPosition {
  let line = 0;
  let start = 0;
  for (;;) {
    const newline = bytes.indexOf(10, start);
    if (newline < 0 || newline >= offset) break;
    line += 1;
    start = newline + 1;
  }
  return { line, character: bytes.toString("utf8", start, offset).length };
}

interface LineShape {
  start: number;
  /** Where the line's text ends, before its line break. */
  end: number;
  /** Where its `//` comment starts. */
  comment: number | null;
}

/**
 * Where `target` is in Go source `text`, or null when a comment can't go at its end: it's past the
 * end of the file, ends inside a raw string or block comment, or holds no code.
 */
function scanLine(text: string, target: number): LineShape | null {
  let state: "code" | "string" | "rune" | "raw" | "block" | "comment" = "code";
  let line = 0;
  let start = 0;
  let hasCode = false;
  let comment: number | null = null;
  for (let index = 0; index <= text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (char === "\n" || char === undefined) {
      if (line === target) {
        if (state === "raw" || state === "block" || !hasCode) return null;
        const end = text[index - 1] === "\r" ? index - 1 : index;
        return { start, end, comment };
      }
      line += 1;
      start = index + 1;
      hasCode = false;
      comment = null;
      if (state !== "raw" && state !== "block") state = "code";
    } else if (state === "code") {
      if (char === "/" && next === "/") {
        state = "comment";
        comment = index;
      } else if (char === "/" && next === "*") {
        state = "block";
        index += 1;
      } else if (char.trim()) {
        hasCode = true;
        if (char === '"') state = "string";
        else if (char === "'") state = "rune";
        else if (char === "`") state = "raw";
      }
    } else if (state === "string" || state === "rune") {
      if (char === "\\" && next !== "\n") index += 1;
      else if (char === (state === "string" ? '"' : "'")) state = "code";
    } else if (state === "raw") {
      hasCode = true;
      if (char === "`") state = "code";
    } else if (state === "block" && char === "*" && next === "/") {
      state = "code";
      index += 1;
    }
  }
  return null;
}
