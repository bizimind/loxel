/**
 * Characters that do not show as themselves when text is displayed, so text a person approves (a
 * command typed into a shell) can be shown with them made visible.
 */

/**
 * Whether `code` is a control character a terminal line editor reads as a key rather than as text:
 * every C0 control but newline (tab completes, CR enters, ^U erases the line, ESC starts a
 * sequence), DEL and the C1 controls.
 */
export function isKeyControl(code: number): boolean {
  return (code < 0x20 && code !== 0x0a) || (code >= 0x7f && code <= 0x9f);
}

/**
 * Characters that display as nothing, or change how the text around them displays: controls,
 * default-ignorable characters (zero-width characters, bidirectional controls, which reorder the text
 * on screen but not the characters a program reads, variation selectors, tag characters) and the
 * line and paragraph separators.
 */
const UNSEEN = /[\p{Cc}\p{Default_Ignorable_Code_Point}\p{Zl}\p{Zp}]/u;

/** Whether `text` holds a key control (see `isKeyControl`). */
export function hasKeyControl(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    if (isKeyControl(text.charCodeAt(i))) return true;
  }
  return false;
}

/** A run of `text`: as is, or one unseen character spelled as an escape (`\r`, `\x15`, `\u202e`). */
export interface TextRun {
  text: string;
  unseen: boolean;
}

const NAMED_ESCAPES: Record<number, string> = { 0x09: "\\t", 0x0d: "\\r", 0x1b: "\\e" };

function escapeFor(code: number): string {
  const named = NAMED_ESCAPES[code];
  if (named) return named;
  const hex = code.toString(16);
  if (code <= 0xff) return `\\x${hex.padStart(2, "0")}`;
  return code <= 0xffff ? `\\u${hex.padStart(4, "0")}` : `\\u{${hex}}`;
}

/** Split `text` into runs, spelling each unseen character as an escape of its own. */
export function revealUnseen(text: string): TextRun[] {
  const runs: TextRun[] = [];
  let plain = "";
  for (const char of text) {
    if (char === "\n" || !UNSEEN.test(char)) {
      plain += char;
      continue;
    }
    if (plain) runs.push({ text: plain, unseen: false });
    plain = "";
    runs.push({ text: escapeFor(char.codePointAt(0)!), unseen: true });
  }
  if (plain) runs.push({ text: plain, unseen: false });
  return runs;
}
