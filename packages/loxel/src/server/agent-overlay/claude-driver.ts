/**
 * Types into Claude Code's TUI on the user's behalf: prompts, dialog answers, mode switches. Every
 * keystroke is preceded by a look at the screen (claude-screen.ts), and every step waits for the
 * screen to show its effect before the next, so the overlay never types into a screen it does not
 * recognize. When the screen is not what an action expects, it throws {@link FallbackError} and the
 * user finishes in the terminal; nothing is typed after the first surprise.
 */
import type { AgentPermissionMode, AgentQuestion } from "@/api/agent-overlay-model";
import { permissionDecisionOf } from "@/api/agent-overlay-model";

import type { ClaudeDialog, ClaudeDialogKind, ScreenOption } from "./claude-screen";
import { permissionModeFromScreen, promptBoxState, recognizeDialog } from "./claude-screen";

/** The terminal the agent runs in, as the driver sees it. */
export interface TerminalIO {
  /** The visible screen, or null when it cannot be read (the terminal ended, an older host). */
  screen(): Promise<readonly string[] | null>;
  write(data: string): void;
}

/** The action cannot be done from the overlay; the user has to do it in the terminal. */
export class FallbackError extends Error {
  override readonly name = "FallbackError";
}

const POLL_MS = 40;
const STEP_TIMEOUT_MS = 3_000;

const KEY = {
  enter: "\r",
  escape: "\x1b",
  up: "\x1b[A",
  down: "\x1b[B",
  tab: "\t",
  backtab: "\x1b[Z",
  space: " ",
} as const;

/**
 * Polls the screen until `read` recognizes it, for state the terminal host cannot announce (it has
 * no screen-change event). Throws a {@link FallbackError} with `what` after `timeoutMs`.
 */
async function waitFor<T>(
  io: TerminalIO,
  read: (lines: readonly string[]) => T | null,
  what: string,
  timeoutMs = STEP_TIMEOUT_MS,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const lines = await io.screen();
    if (lines === null) throw new FallbackError("The terminal's screen cannot be read");
    const found = read(lines);
    if (found !== null) return found;
    if (Date.now() > deadline) throw new FallbackError(`Timed out waiting for ${what}`);
    await Bun.sleep(POLL_MS);
  }
}

function waitForDialog(
  io: TerminalIO,
  kind: ClaudeDialogKind,
  match: (dialog: ClaudeDialog) => boolean = () => true,
): Promise<ClaudeDialog> {
  return waitFor(
    io,
    (lines) => {
      const dialog = recognizeDialog(lines);
      return dialog?.kind === kind && match(dialog) ? dialog : null;
    },
    `Claude's ${kind} dialog`,
  );
}

function selectedOf(dialog: ClaudeDialog): ScreenOption {
  return dialog.options.find((option) => option.selected) ?? dialog.options[0]!;
}

/** Moves the dialog's cursor to `target`, one arrow at a time, each confirmed on screen. */
async function moveTo(io: TerminalIO, dialog: ClaudeDialog, target: ScreenOption): Promise<void> {
  let current = selectedOf(dialog);
  while (current.number !== target.number) {
    const key = target.number > current.number ? KEY.down : KEY.up;
    const from = current.number;
    io.write(key);
    current = await waitFor(
      io,
      (lines) => {
        const now = recognizeDialog(lines);
        if (now?.kind !== dialog.kind) return null;
        const selected = selectedOf(now);
        return selected.number === from ? null : selected;
      },
      "the dialog's cursor to move",
    );
  }
}

function findOption(dialog: ClaudeDialog, pattern: RegExp, what: string): ScreenOption {
  const option = dialog.options.find((candidate) => pattern.test(candidate.label));
  if (!option) {
    const shown = dialog.options.map((candidate) => candidate.label).join(", ");
    throw new FallbackError(`Claude's dialog has no "${what}" choice (it shows: ${shown})`);
  }
  return option;
}

async function waitUntilGone(io: TerminalIO, kind: ClaudeDialogKind): Promise<void> {
  await waitFor(
    io,
    (lines) => (recognizeDialog(lines)?.kind === kind ? null : true),
    `the ${kind} dialog to close`,
  );
}

/** Text safe to paste: tabs and newlines kept, other control characters (escape sequences) refused. */
function pasteable(text: string): string {
  const normalized = text.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  for (const character of normalized) {
    const code = character.codePointAt(0) ?? 0;
    if ((code < 32 && code !== 9 && code !== 10) || code === 127) {
      throw new FallbackError("The text contains terminal control characters");
    }
  }
  return normalized;
}

function paste(io: TerminalIO, text: string): void {
  io.write(`\x1b[200~${pasteable(text)}\x1b[201~`);
}

/**
 * Submit a prompt (or a `/command`) through the input box. Refused while a dialog is up, and while
 * the box holds a draft the user typed in the terminal, which it would otherwise be appended to.
 * While Claude works, it queues the prompt itself.
 */
export async function submitPrompt(io: TerminalIO, text: string): Promise<void> {
  const lines = await io.screen();
  if (lines === null) throw new FallbackError("The terminal's screen cannot be read");
  if (recognizeDialog(lines))
    throw new FallbackError("Claude is waiting on a dialog; answer it first");
  const box = promptBoxState(lines);
  if (box === "absent") throw new FallbackError("Claude's input box is not on screen");
  if (box === "draft") {
    throw new FallbackError("The terminal has unsent input; send or clear it there first");
  }
  paste(io, text);
  await waitFor(io, (now) => (promptBoxState(now) === "draft" ? true : null), "the pasted prompt");
  io.write(KEY.enter);
}

/** Esc: interrupts the turn (and closes a dialog, which Claude counts as a refusal). */
export function interrupt(io: TerminalIO): void {
  io.write(KEY.escape);
}

/** Answer the permission prompt on screen; a refusal with feedback sends it as the next prompt. */
export async function answerPermission(
  io: TerminalIO,
  decision: "allow" | "always" | "deny",
  feedback?: string,
): Promise<void> {
  const dialog = await waitForDialog(io, "permission");
  const target = dialog.options.find((option) => permissionDecisionOf(option.label) === decision);
  if (!target) {
    const shown = dialog.options.map((option) => option.label).join(", ");
    throw new FallbackError(`Claude's dialog has no "${decision}" choice (it shows: ${shown})`);
  }
  await moveTo(io, dialog, target);
  io.write(KEY.enter);
  await waitUntilGone(io, "permission");
  if (decision === "deny" && feedback?.trim()) {
    await waitFor(
      io,
      (lines) => (promptBoxState(lines) === "empty" ? true : null),
      "the input box",
    );
    await submitPrompt(io, feedback);
  }
}

/**
 * Answer the plan approval. `revise` with feedback types it into the "Tell Claude what to change"
 * choice; without feedback it is Esc, which keeps Claude in plan mode.
 */
export async function answerPlan(
  io: TerminalIO,
  decision: "approve-auto" | "approve-manual" | "revise",
  feedback?: string,
): Promise<void> {
  const dialog = await waitForDialog(io, "plan");
  if (decision === "revise" && !feedback?.trim()) {
    io.write(KEY.escape);
    await waitUntilGone(io, "plan");
    return;
  }
  const target =
    decision === "approve-auto"
      ? findOption(dialog, /auto mode|auto-accept/iu, "Yes, and use auto mode")
      : decision === "approve-manual"
        ? findOption(dialog, /manually approve/iu, "Yes, manually approve edits")
        : findOption(dialog, /what to change|keep planning/iu, "Tell Claude what to change");
  await moveTo(io, dialog, target);
  if (decision === "revise" && feedback) paste(io, feedback);
  io.write(KEY.enter);
  await waitUntilGone(io, "plan");
}

const sameText = (a: string, b: string) =>
  a.replace(/\s+/gu, " ").trim() === b.replace(/\s+/gu, " ").trim();
const FREE_TEXT = /^Type something/iu;
const CHAT = /^Chat about this/iu;

/** Answer an AskUserQuestion dialog page by page, then submit on its review page. */
export async function answerQuestions(
  io: TerminalIO,
  questions: readonly AgentQuestion[],
  answers: readonly { labels: readonly string[]; other?: string }[],
): Promise<void> {
  for (const [index, question] of questions.entries()) {
    const answer = answers[index];
    if (!answer) throw new FallbackError(`No answer for "${question.question}"`);
    let page = await waitForDialog(
      io,
      "question",
      (dialog) => dialog.prompt !== null && sameText(dialog.prompt, question.question),
    );
    const other = answer.other?.trim();
    if (other) {
      if (question.multiSelect) {
        throw new FallbackError(
          "Free text on a multiple-choice question is answered in the terminal",
        );
      }
      await moveTo(io, page, findOption(page, FREE_TEXT, "Type something"));
      paste(io, other);
      io.write(KEY.enter);
    } else if (!question.multiSelect) {
      const label = answer.labels[0];
      if (answer.labels.length !== 1 || label === undefined) {
        throw new FallbackError(`"${question.question}" takes exactly one choice`);
      }
      await moveTo(io, page, findOption(page, new RegExp(`^${escapeRegExp(label)}$`, "u"), label));
      io.write(KEY.enter);
    } else {
      const wanted = new Set(answer.labels);
      for (const option of page.options) {
        if (FREE_TEXT.test(option.label) || CHAT.test(option.label) || option.checked === null)
          continue;
        if (option.checked === wanted.has(option.label)) continue;
        await moveTo(io, page, option);
        io.write(KEY.space);
        const toggled = option.number;
        page = await waitForDialog(
          io,
          "question",
          (dialog) => dialog.options.find((o) => o.number === toggled)?.checked !== option.checked,
        );
      }
      io.write(KEY.tab);
    }
    // The next page: another question, or the review page.
    await waitFor(
      io,
      (lines) => {
        const next = recognizeDialog(lines);
        if (!next) return true;
        if (next.kind === "question" && next.prompt && sameText(next.prompt, question.question)) {
          return null;
        }
        return true;
      },
      "the next question",
    );
  }
  const lines = await io.screen();
  const review = lines ? recognizeDialog(lines) : null;
  if (review?.kind !== "question-review") return;
  await moveTo(io, review, findOption(review, /^Submit/iu, "Submit answers"));
  io.write(KEY.enter);
  await waitUntilGone(io, "question-review");
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`);
}

/** Cycle Shift+Tab until the footer shows `mode`; refused when the cycle never reaches it. */
export async function setPermissionMode(io: TerminalIO, mode: AgentPermissionMode): Promise<void> {
  const seen = new Set<AgentPermissionMode>();
  for (let attempt = 0; attempt < 8; attempt++) {
    const lines = await io.screen();
    if (lines === null) throw new FallbackError("The terminal's screen cannot be read");
    if (recognizeDialog(lines))
      throw new FallbackError("Claude is waiting on a dialog; answer it first");
    const current = permissionModeFromScreen(lines);
    if (current === null) throw new FallbackError("Claude's permission mode is not on screen");
    if (current === mode) return;
    if (seen.has(current)) {
      throw new FallbackError(`${mode} is not one of the modes Shift+Tab cycles through here`);
    }
    seen.add(current);
    io.write(KEY.backtab);
    await waitFor(
      io,
      (now) => {
        const next = permissionModeFromScreen(now);
        return next !== null && next !== current ? next : null;
      },
      "the permission mode to change",
    );
  }
  throw new FallbackError(`Could not switch to ${mode}`);
}
