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
 * format characters, default-ignorable characters (zero-width characters, bidirectional controls, which reorder the text
 * on screen but not the characters a program reads, variation selectors, tag characters) and the
 * line and paragraph separators.
 */
const UNSEEN = /[\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}\p{Zl}\p{Zp}]/gu;

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
  /** How many UTF-16 units of the source text the run stands for. */
  length: number;
}

const NAMED_ESCAPES: Record<number, string> = { 0x09: "\\t", 0x0d: "\\r", 0x1b: "\\e" };

function escapeFor(code: number): string {
  const named = NAMED_ESCAPES[code];
  if (named) return named;
  const hex = code.toString(16);
  if (code <= 0xff) return `\\x${hex.padStart(2, "0")}`;
  return code <= 0xffff ? `\\u${hex.padStart(4, "0")}` : `\\u{${hex}}`;
}

export interface RevealOptions {
  /**
   * The text is content (code, file names) rather than a command, so what is ordinary writing in
   * it stays as it is: tabs and carriage returns (indentation and line endings), the joiners and
   * selectors inside an emoji sequence (a family emoji, a check mark with its emoji presentation
   * selector), and a zero-width joiner or non-joiner
   * between letters of a script other than Latin, Greek or Cyrillic, where it is spelling (Persian,
   * Hindi). Bidirectional controls, and joiners anywhere else, are still revealed.
   */
  content?: boolean;
}

const EMOJI = /\p{RGI_Emoji}/gv;
const JOINERS = new Set(["\u200c", "\u200d"]);
const SPELLED_WITH_JOINERS =
  /^[[\p{L}\p{M}]--[\p{Script=Latin}\p{Script=Greek}\p{Script=Cyrillic}\p{Script=Common}\p{Script=Inherited}]]$/v;

/** Whether the unseen `char` at `index` of `text` is part of its writing (see `content`). */
function isWriting(text: string, char: string, index: number, emoji: [number, number][]): boolean {
  if (char === "\t" || char === "\r") return true;
  if (emoji.some(([start, end]) => index > start && index < end)) return true;
  return (
    JOINERS.has(char) &&
    SPELLED_WITH_JOINERS.test(text[index - 1] ?? "") &&
    SPELLED_WITH_JOINERS.test(text[index + 1] ?? "")
  );
}

/** Each unseen character of `text`, with its index and escape; newlines are never unseen. */
function* unseenChars(text: string, { content = false }: RevealOptions) {
  const emoji: [number, number][] = content
    ? [...text.matchAll(EMOJI)].map((match) => [match.index, match.index + match[0].length])
    : [];
  for (const match of text.matchAll(UNSEEN)) {
    const char = match[0];
    if (char === "\n" || (content && isWriting(text, char, match.index, emoji))) continue;
    yield { index: match.index, length: char.length, escape: escapeFor(char.codePointAt(0)!) };
  }
}

/** Split `text` into runs, spelling each unseen character as an escape of its own. */
export function revealUnseen(text: string, options: RevealOptions = {}): TextRun[] {
  const runs: TextRun[] = [];
  let start = 0;
  for (const { index, length, escape } of unseenChars(text, options)) {
    if (index > start) runs.push(plainRun(text.slice(start, index)));
    runs.push({ text: escape, unseen: true, length });
    start = index + length;
  }
  if (start < text.length) runs.push(plainRun(text.slice(start)));
  return runs;
}

const plainRun = (text: string): TextRun => ({ text, unseen: false, length: text.length });

/**
 * The part of `runs` (of some source text) that stands for the source between offsets `from` and
 * `to`, so a slice of a text reveals exactly as it does within the whole text.
 */
export function sliceRuns(runs: TextRun[], from: number, to: number): TextRun[] {
  const sliced: TextRun[] = [];
  let offset = 0;
  for (const run of runs) {
    const end = offset + run.length;
    if (run.unseen) {
      if (offset >= from && offset < to) sliced.push(run);
    } else if (end > from && offset < to) {
      sliced.push(plainRun(run.text.slice(Math.max(from - offset, 0), Math.min(to, end) - offset)));
    }
    offset = end;
  }
  return sliced;
}

/**
 * Replace each unseen character of `text` with `render(escape)`: for markup such as highlighted
 * code, whose attributes hold no text of the source.
 */
export function replaceUnseen(
  text: string,
  render: (escape: string) => string,
  options: RevealOptions = {},
): string {
  let result = "";
  let start = 0;
  for (const { index, length, escape } of unseenChars(text, options)) {
    result += text.slice(start, index) + render(escape);
    start = index + length;
  }
  return result + text.slice(start);
}
