import type { IndentationLayer } from "@/store/settings-store";

/** Lines read; Monaco's guesser stops at the same count. */
const MAX_LINES = 10_000;
/** Even sizes first, so that a tie goes to the more common choice. */
const SIZE_CANDIDATES = [2, 4, 6, 8, 3, 5, 7];
const MAX_SIZE = 8;

/**
 * Guess a file's indentation from its content: tabs or spaces by which indents more lines, and
 * for spaces the size by the most common indent step between consecutive non-blank lines. Sets
 * only what the content shows: nothing for a file without indented lines, and no size for tabs,
 * whose display width the content cannot tell.
 *
 * Adapted from Monaco's `guessIndentation` (indentationGuesser.ts, MIT), which is internal to
 * monaco-editor and returns the defaults it is given instead of reporting what it could not tell.
 */
export function detectIndentation(content: string): IndentationLayer {
  let tabLines = 0;
  let spaceLines = 0;
  const stepCounts = Array.from({ length: MAX_SIZE + 1 }, () => 0);
  let previousLine = "";
  let previousIndent = "";
  let start = 0;
  for (let n = 0; n < MAX_LINES && start < content.length; n++) {
    const newline = content.indexOf("\n", start);
    const end = newline === -1 ? content.length : newline;
    const line = content.slice(start, content[end - 1] === "\r" ? end - 1 : end);
    start = end + 1;

    const indent = /^[\t ]*/.exec(line)?.[0] ?? "";
    if (line.slice(indent.length).trim() === "") continue;
    if (indent.includes("\t")) tabLines++;
    else if (indent.length > 1) spaceLines++;

    const step = indentStep(previousLine, previousIndent, indent);
    if (step === "alignment") continue;
    if (step !== null && step <= MAX_SIZE) stepCounts[step]! += 1;
    previousLine = line;
    previousIndent = indent;
  }

  if (tabLines === spaceLines) return {};
  if (tabLines > spaceLines) return { insertSpaces: false };

  let size: number | undefined;
  let best = 0;
  for (const candidate of SIZE_CANDIDATES) {
    if (stepCounts[candidate]! > best) {
      best = stepCounts[candidate]!;
      size = candidate;
    }
  }
  // Deeper nesting (YAML, JSON) produces 4-column steps in a 2-space file: let 2 win when it has
  // at least two thirds of 4's count.
  if (size === 4 && stepCounts[2]! > 0 && stepCounts[2]! >= (stepCounts[4]! * 2) / 3) size = 2;
  return size === undefined
    ? { insertSpaces: true }
    : { insertSpaces: true, tabSize: size, indentSize: size };
}

/**
 * The indent step, in columns, from one line's indentation to the next's, after their common
 * prefix; null when it cannot be told (mixed tabs and spaces). `"alignment"` marks a line that
 * continues a comma-ended one, starting right after a space in it (`const a = 1,` / `      b = 2;`):
 * that aligns with the previous line and says nothing about the indent size.
 */
function indentStep(
  previousLine: string,
  previousIndent: string,
  indent: string,
): number | "alignment" | null {
  let common = 0;
  while (
    common < previousIndent.length &&
    common < indent.length &&
    previousIndent[common] === indent[common]
  ) {
    common++;
  }
  const a = previousIndent.slice(common);
  const b = indent.slice(common);
  const aTabs = a.split("\t").length - 1;
  const bTabs = b.split("\t").length - 1;
  const aSpaces = a.length - aTabs;
  const bSpaces = b.length - bTabs;
  if ((aSpaces > 0 && aTabs > 0) || (bSpaces > 0 && bTabs > 0)) return null;

  const tabsDiff = Math.abs(aTabs - bTabs);
  const spacesDiff = Math.abs(aSpaces - bSpaces);
  if (tabsDiff === 0) {
    const alignsWithPrevious =
      indent.length > previousIndent.length &&
      previousLine[indent.length - 1] === " " &&
      previousLine.trimEnd().endsWith(",");
    return alignsWithPrevious ? "alignment" : spacesDiff;
  }
  return spacesDiff % tabsDiff === 0 ? spacesDiff / tabsDiff : null;
}
