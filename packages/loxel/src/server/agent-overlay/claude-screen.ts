/**
 * Recognizers for what Claude Code's TUI shows, over the plain-text screen the terminal host
 * returns. They are used only to confirm that the dialog the hooks announced is on screen and to
 * find its choices before typing into it, never to read the conversation (that comes from the
 * transcript). Each recognizer answers null for anything it does not know, so a new or changed
 * dialog sends the user to the terminal instead of being answered blindly. The patterns come from
 * recorded screens (fixtures/, recorded with scripts/capture-claude-tui.ts).
 */
import type { AgentDialogOption, AgentPermissionMode } from "@/api/agent-overlay-model";

/** A dialog the overlay knows how to answer. */
export type ClaudeDialogKind = "permission" | "plan" | "question" | "question-review";

export interface ScreenOption extends AgentDialogOption {
  /** The row the option starts on. */
  row: number;
  /** The cursor (`❯`) is on this option. */
  selected: boolean;
  /** A multi-select option's checkbox: true checked, false unchecked, null none. */
  checked: boolean | null;
}

export interface ClaudeDialog {
  kind: ClaudeDialogKind;
  /** For question pages, the question being asked. */
  prompt: string | null;
  options: ScreenOption[];
}

const RULE = /^\s*[─━]{20,}\s*$/u;
const OPTION = /^\s*(❯\s+)?(\d+)\.\s+(.*?)\s*$/u;
const CHECKBOX = /^\[([ ✔✓xX])\]\s*(.*)$/u;
/** Lines that end a dialog's option list: its key hints. */
const FOOTER = /Esc to cancel|Enter to select|Tab to amend|ctrl\+g to edit|shift\+tab to approve/iu;
/** The question tabs: `←  ☐ Color  ☐ Fruit  ✔ Submit  →`, or ` ☐ Size ` for a single question. */
const QUESTION_TABS = /^\s*(?:←\s+)?[☐☒✔□]\s+\S.*$/u;

/** The numbered options from `start` down, until the dialog's key hints. */
export function parseOptions(lines: readonly string[], start: number): ScreenOption[] {
  const options: ScreenOption[] = [];
  for (let row = start; row < lines.length; row++) {
    const line = lines[row] ?? "";
    if (FOOTER.test(line)) break;
    const match = OPTION.exec(line);
    if (!match) continue;
    const rawLabel = match[3] ?? "";
    const checkbox = CHECKBOX.exec(rawLabel);
    options.push({
      number: Number(match[2]),
      label: (checkbox ? (checkbox[2] ?? "") : rawLabel).trim(),
      row,
      selected: match[1] !== undefined,
      checked: checkbox ? checkbox[1] !== " " : null,
    });
  }
  return options;
}

/** The last row matching `pattern`, or -1. */
function lastRow(lines: readonly string[], pattern: RegExp): number {
  for (let row = lines.length - 1; row >= 0; row--) {
    if (pattern.test(lines[row] ?? "")) return row;
  }
  return -1;
}

/**
 * The dialog the screen shows, when it is one the overlay knows: a tool permission prompt, the plan
 * approval, an AskUserQuestion page or its review page. Null for anything else, including dialogs
 * that look similar but are not these (the workspace trust prompt, `/model`).
 */
export function recognizeDialog(lines: readonly string[]): ClaudeDialog | null {
  // A dialog replaces the input box; text above an input box is conversation, not a dialog.
  const input = promptRow(lines);
  const anchored = (row: number): boolean => row >= 0 && row > input;
  const plan = lastRow(lines, /Would you like to proceed\?\s*$/u);
  if (anchored(plan)) {
    const options = parseOptions(lines, plan + 1);
    if (options.length >= 2) return { kind: "plan", prompt: null, options };
  }
  const review = lastRow(lines, /^\s*Ready to submit your answers\?\s*$/u);
  if (anchored(review)) {
    const options = parseOptions(lines, review + 1);
    if (options.length >= 1) return { kind: "question-review", prompt: null, options };
  }
  const tabs = lastRow(lines, QUESTION_TABS);
  if (anchored(tabs)) {
    let promptAt = tabs + 1;
    while (promptAt < lines.length && (lines[promptAt] ?? "").trim() === "") promptAt++;
    const prompt = (lines[promptAt] ?? "").trim();
    const options = parseOptions(lines, promptAt + 1);
    if (prompt && options.length >= 1) return { kind: "question", prompt, options };
  }
  const permission = lastRow(lines, /^\s*Do you want to .+\?\s*$/u);
  if (anchored(permission)) {
    const options = parseOptions(lines, permission + 1);
    if (options.length >= 2) return { kind: "permission", prompt: null, options };
  }
  return null;
}

/** The input box: a rule, the `❯` prompt line, and a rule below it. Returns the prompt row. */
export function promptRow(lines: readonly string[]): number {
  for (let row = lines.length - 2; row > 0; row--) {
    if (!/^❯/u.test(lines[row] ?? "")) continue;
    if (!RULE.test(lines[row - 1] ?? "")) continue;
    for (let below = row + 1; below < lines.length; below++) {
      if (RULE.test(lines[below] ?? "")) return row;
    }
  }
  return -1;
}

/** Whether the input box is shown and empty, so a prompt can be typed without losing a draft. */
export function promptBoxState(lines: readonly string[]): "empty" | "draft" | "absent" {
  const row = promptRow(lines);
  if (row < 0) return "absent";
  const text = (lines[row] ?? "").replace(/^❯/u, "").trim();
  return text.length === 0 ? "empty" : "draft";
}

/** The permission mode the footer shows; `manual` is Claude Code's name for `default`. */
export function permissionModeFromScreen(lines: readonly string[]): AgentPermissionMode | null {
  const footer = lines.slice(Math.max(0, promptRow(lines))).join("\n");
  if (/\bplan mode on\b/iu.test(footer)) return "plan";
  if (/\bauto mode on\b/iu.test(footer)) return "auto";
  if (/\baccept edits(?: mode)? on\b/iu.test(footer)) return "acceptEdits";
  if (/\bbypass permissions(?: mode)? on\b/iu.test(footer)) return "bypassPermissions";
  if (/\bdon.t ask(?: mode)? on\b/iu.test(footer)) return "dontAsk";
  if (/\b(?:manual|default) mode on\b/iu.test(footer)) return "default";
  return null;
}
