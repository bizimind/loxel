/**
 * Lenient parser from unified diff text (a ```diff fence, a `.patch` file, an agent's message) to
 * Loxel's diff model.
 *
 * Such text is often not a valid patch: hunk headers carry wrong line counts or no numbers at all
 * (`@@ ... @@`), file headers are missing, or there are no headers and only `+`/`-`/` ` lines.
 * The parser keeps whatever structure the text has:
 *
 * - `diff --git`, `---`/`+++` and git's extended headers start and describe files.
 * - `@@ -a,b +c,d @@` starts a numbered hunk. Its counts only disambiguate: while they say lines
 *   remain, a `--- x` line or a blank line is content. Lines past the counts that still look like
 *   hunk lines extend the hunk rather than being dropped.
 * - Hunk lines with no numbered header form an unnumbered hunk: no line numbers, and every line is
 *   kept (unrecognized ones as context), so a loose snippet renders completely.
 *
 * Returns null when the text has no file header and no added or removed line, so callers can
 * show it as plain text instead.
 */
import type { DiffHunk, DiffInfo, DiffLine, FileDiff } from "@/api/diff-model";
import { parseGitHeaderPaths, unquoteCString } from "@/lib/git-diff-paths";

const HUNK_HEADER = /^@@+ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@+/;
/** Side prefixes git writes: a/ b/, or with diff.mnemonicPrefix c/ i/ o/ w/ and 1/ 2/ */
const OLD_SIDE_PREFIX = /^[acio1]\//;
const NEW_SIDE_PREFIX = /^[biw2]\//;
const EXTENDED_HEADER = /^(?:index |old mode |new mode |similarity index |dissimilarity index )/;
const NO_NEWLINE_MARKER = "\\ No newline at end of file";
const SIGNATURE_SEPARATOR = "-- ";

/** Parse unified diff text leniently; null when it holds no diff at all. */
export function parseUnifiedDiff(text: string): DiffInfo | null {
  const parser = new PatchParser();
  const lines = text.split("\n").map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
  if (lines.at(-1) === "") lines.pop();
  for (let i = 0; i < lines.length; i++) {
    if (parser.consume(lines[i]!, lines[i + 1], lines[i + 2])) i++;
  }
  return parser.finish();
}

interface OpenFile {
  file: FileDiff;
  /** Started by a `diff --git` line, so it is a change even without hunks (rename, mode, binary) */
  fromGit: boolean;
  /** Started by a `diff --git` line whose `---`/`+++` pair has not been seen yet */
  awaitingPathHeaders: boolean;
}

interface OpenHunk {
  file: FileDiff;
  hunk: DiffHunk;
  numbered: boolean;
  oldLine: number;
  newLine: number;
  /** Lines the header's counts still expect on each side (0 for unnumbered hunks) */
  oldRemaining: number;
  newRemaining: number;
  /** Blank source lines past the counts: content if a hunk line follows, dropped otherwise */
  pendingBlanks: number;
}

class PatchParser {
  private readonly files: OpenFile[] = [];
  private file: OpenFile | null = null;
  private hunk: OpenHunk | null = null;

  /**
   * Consume one line, seeing the two after it; returns true when it also consumed `next` (a
   * `---`/`+++` pair).
   */
  consume(line: string, next: string | undefined, afterNext: string | undefined): boolean {
    const hunk = this.hunk;
    const countsLeft = hunk !== null && (hunk.oldRemaining > 0 || hunk.newRemaining > 0);

    // `--- x` followed by `+++ y` is a file header, unless the open hunk still expects lines:
    // then they are a removed `-- x` and an added `++ y`. A `@@` right after the pair still
    // makes it a header, as the counts were too high.
    const isPathHeader =
      line.startsWith("--- ") &&
      next?.startsWith("+++ ") &&
      (!countsLeft || afterNext?.startsWith("@@"));
    if (isPathHeader && next !== undefined) {
      this.closeHunk();
      const open = this.file?.awaitingPathHeaders ? this.file : this.openFile(false);
      open.awaitingPathHeaders = false;
      applyPathHeaders(open.file, line.slice(4), next.slice(4));
      return true;
    }

    // Neither can be a hunk line, so they always start something new.
    const gitPaths = parseGitHeaderPaths(line);
    if (gitPaths) {
      const open = this.openFile(true);
      open.awaitingPathHeaders = true;
      open.file.oldPath = gitPaths.oldPath;
      open.file.newPath = gitPaths.newPath;
      return false;
    }
    if (line.startsWith("@@")) {
      this.openHunk(line, line.match(HUNK_HEADER));
      return false;
    }

    // `git format-patch` ends the last hunk with a `-- ` signature separator.
    if (line === SIGNATURE_SEPARATOR && hunk?.numbered && !countsLeft) {
      this.closeHunk();
      return false;
    }

    const type = hunkLineType(line);
    if (hunk) {
      if (line === "") {
        if (countsLeft) this.pushLine(hunk, "normal", "");
        else hunk.pendingBlanks++;
        return false;
      }
      // An unrecognized line is context (likely one that lost its leading space) while the counts
      // expect lines or in a loose snippet, rather than dropping its text.
      if (type || !hunk.numbered || countsLeft) {
        this.flushPendingBlanks(hunk);
        if (line === NO_NEWLINE_MARKER) hunk.hunk.lines.push({ type: "normal", content: line });
        else if (type) this.pushLine(hunk, type, line.slice(1));
        else this.pushLine(hunk, "normal", line);
        return false;
      }
      this.closeHunk();
    }

    if (this.file && applyExtendedHeader(this.file, line)) return false;
    if (type && line !== NO_NEWLINE_MARKER) {
      // Hunk lines with no `@@` header: a snippet, or a file header followed directly by lines.
      this.pushLine(this.openHunk("", null), type, line.slice(1));
    }
    // Anything else outside a hunk (commit message, prose) is not part of the diff.
    return false;
  }

  finish(): DiffInfo | null {
    this.closeHunk();
    // Once the text names files, lines before the first one are a preamble (a `git format-patch`
    // mail's `---` separator and diffstat), not a change of their own.
    // A named file needs hunks or a `diff --git` line (a rename, mode change or binary file), so
    // a lone `---`/`+++` pair is not a diff.
    const named = this.files.filter(({ file }) => file.oldPath !== "" || file.newPath !== "");
    if (named.length > 0) {
      const files = named
        .filter(({ file, fromGit }) => fromGit || file.hunks.length > 0)
        .map(({ file }) => file);
      return files.length > 0 ? { files, baseRef: null } : null;
    }
    const files = this.files.map(({ file }) => file);
    const hasChanges = files.some((file) => file.additions + file.deletions > 0);
    return hasChanges ? { files, baseRef: null } : null;
  }

  private openFile(fromGit: boolean): OpenFile {
    this.closeHunk();
    const file: FileDiff = {
      oldPath: "",
      newPath: "",
      status: "modified",
      hunks: [],
      isBinary: false,
      additions: 0,
      deletions: 0,
    };
    this.file = { file, fromGit, awaitingPathHeaders: false };
    this.files.push(this.file);
    return this.file;
  }

  private openHunk(header: string, match: RegExpMatchArray | null): OpenHunk {
    this.closeHunk();
    const { file } = this.file ?? this.openFile(false);
    const oldStart = match ? Number(match[1]) : 0;
    const newStart = match ? Number(match[3]) : 0;
    const hunk: DiffHunk = { oldStart, oldLines: 0, newStart, newLines: 0, header, lines: [] };
    file.hunks.push(hunk);
    this.hunk = {
      file,
      hunk,
      numbered: match !== null,
      oldLine: oldStart,
      newLine: newStart,
      oldRemaining: match ? Number(match[2] ?? "1") : 0,
      newRemaining: match ? Number(match[4] ?? "1") : 0,
      pendingBlanks: 0,
    };
    return this.hunk;
  }

  /** Close the open hunk, setting its line counts to the lines it actually holds. */
  private closeHunk(): void {
    if (!this.hunk) return;
    const { hunk } = this.hunk;
    const counted = hunk.lines.filter((line) => line.content !== NO_NEWLINE_MARKER);
    hunk.oldLines = counted.filter((line) => line.type !== "add").length;
    hunk.newLines = counted.filter((line) => line.type !== "delete").length;
    this.hunk = null;
  }

  private pushLine(open: OpenHunk, type: DiffLine["type"], content: string): void {
    const line: DiffLine = { type, content };
    if (type !== "add") {
      open.oldRemaining--;
      if (open.numbered) line.oldLineNumber = open.oldLine++;
    }
    if (type !== "delete") {
      open.newRemaining--;
      if (open.numbered) line.newLineNumber = open.newLine++;
    }
    if (type === "add") open.file.additions++;
    if (type === "delete") open.file.deletions++;
    open.hunk.lines.push(line);
  }

  private flushPendingBlanks(open: OpenHunk): void {
    for (; open.pendingBlanks > 0; open.pendingBlanks--) this.pushLine(open, "normal", "");
  }
}

function hunkLineType(line: string): DiffLine["type"] | null {
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "delete";
  if (line.startsWith(" ") || line.startsWith("\\")) return "normal";
  return null;
}

/** Apply a git extended header line; returns whether the line was one. */
function applyExtendedHeader({ file }: OpenFile, line: string): boolean {
  if (line.startsWith("new file mode")) file.status = "added";
  else if (line.startsWith("deleted file mode")) file.status = "deleted";
  else if (line.startsWith("rename from ")) {
    file.status = "renamed";
    file.oldPath = line.slice("rename from ".length);
  } else if (line.startsWith("rename to ")) file.newPath = line.slice("rename to ".length);
  else if (line.startsWith("copy from ")) {
    file.status = "copied";
    file.oldPath = line.slice("copy from ".length);
  } else if (line.startsWith("copy to ")) file.newPath = line.slice("copy to ".length);
  else if (line.startsWith("Binary files ") || line === "GIT binary patch") file.isBinary = true;
  else return EXTENDED_HEADER.test(line);
  return true;
}

/** Set a file's paths, and its status when the header implies one, from `---`/`+++` values. */
function applyPathHeaders(file: FileDiff, oldHeader: string, newHeader: string): void {
  let oldPath = headerPath(oldHeader);
  let newPath = headerPath(newHeader);
  // git and most tools prefix the two sides (a/ and b/ by default); strip them only as a pair
  // (a side that is /dev/null has no prefix).
  if (OLD_SIDE_PREFIX.test(oldPath ?? "a/") && NEW_SIDE_PREFIX.test(newPath ?? "b/")) {
    oldPath = oldPath?.slice(2) ?? null;
    newPath = newPath?.slice(2) ?? null;
  }
  if (oldPath === null) file.status = "added";
  else if (newPath === null) file.status = "deleted";
  else if (oldPath !== newPath && file.status === "modified") file.status = "renamed";
  file.oldPath = oldPath ?? newPath ?? "";
  file.newPath = newPath ?? oldPath ?? "";
}

/** The path in a `---`/`+++` value, C-quoted by git when unusual; null for /dev/null. */
function headerPath(value: string): string | null {
  const quoted = value.startsWith('"') ? unquoteCString(value, 0) : null;
  // Unquoted values may end in a tab and a timestamp (diff -u).
  const path = quoted ? quoted.value : value.split("\t")[0]!.trim();
  return path === "/dev/null" ? null : path;
}
