import type { DiffHunk, DiffLine, FileDiff } from "@/api/diff-model";
import { gitPathValue, parseGitHeaderPaths } from "@/lib/git-diff-paths";

const HUNK_HEADER = /^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@(.*)$/;

/**
 * Parse unified diff output from git diff.
 *
 * Returns only the files: the diff's base is not recoverable from its text,
 * so the caller — which knows the revisions it asked about — supplies it.
 */
export function parseDiffOutput(output: string): FileDiff[] {
  const files: FileDiff[] = [];

  if (!output.trim()) {
    return files;
  }

  // Every content line starts with `+`, `-`, ` ` or `\`, so only a file header starts this way.
  const diffPattern = /^diff --git/gm;
  const parts = output.split(diffPattern).filter(Boolean);

  for (const part of parts) {
    const file = parseFileDiff("diff --git" + part);
    if (file) {
      files.push(file);
    }
  }

  return files;
}

/**
 * Parse a single file diff.
 */
function parseFileDiff(content: string): FileDiff | null {
  const lines = content.split("\n");
  const firstLine = lines[0];
  if (!firstLine) return null;

  const paths = parseGitHeaderPaths(firstLine);
  if (!paths) return null;
  let { oldPath, newPath } = paths;

  // Extended headers, up to the first hunk. `rename`/`copy` lines name both sides on their own,
  // which the `diff --git` line cannot do unambiguously when the names differ.
  let status: FileDiff["status"] = "modified";
  let isBinary = false;
  let index = 1;
  for (; index < lines.length && !lines[index]!.startsWith("@@"); index++) {
    const line = lines[index]!;
    if (line.startsWith("new file mode")) {
      status = "added";
    } else if (line.startsWith("deleted file mode")) {
      status = "deleted";
    } else if (line.startsWith("rename from ")) {
      status = "renamed";
      oldPath = gitPathValue(line.slice("rename from ".length));
    } else if (line.startsWith("rename to ")) {
      newPath = gitPathValue(line.slice("rename to ".length));
    } else if (line.startsWith("copy from ")) {
      status = "copied";
      oldPath = gitPathValue(line.slice("copy from ".length));
    } else if (line.startsWith("copy to ")) {
      newPath = gitPathValue(line.slice("copy to ".length));
    } else if (line.startsWith("Binary files")) {
      isBinary = true;
    }
  }

  const hunks = isBinary ? [] : parseHunks(lines.slice(index));
  const counted = hunks.flatMap((hunk) => hunk.lines);
  const additions = counted.filter((line) => line.type === "add").length;
  const deletions = counted.filter((line) => line.type === "delete").length;

  return { oldPath, newPath, status, hunks, isBinary, additions, deletions };
}

/**
 * Parse the hunks of one file. A hunk holds exactly the lines its `@@` header counts, and each one
 * is classified by its first character alone, so `++x` is an added `+x` and `---` a removed `--`.
 */
function parseHunks(lines: string[]): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  let hunk: DiffHunk | null = null;
  let oldLine = 0;
  let newLine = 0;
  let oldRemaining = 0;
  let newRemaining = 0;

  for (const line of lines) {
    if (hunk && line.startsWith("\\")) {
      // "\ No newline at end of file", after the last line of either side: no line number change
      hunk.lines.push({ type: "normal", content: line });
      continue;
    }
    const type = hunk && (oldRemaining > 0 || newRemaining > 0) ? lineType(line) : null;
    if (hunk && type) {
      const parsed: DiffLine = { type, content: line.slice(1) };
      if (type !== "add") {
        parsed.oldLineNumber = oldLine++;
        oldRemaining--;
      }
      if (type !== "delete") {
        parsed.newLineNumber = newLine++;
        newRemaining--;
      }
      hunk.lines.push(parsed);
      continue;
    }
    // Anything else ends the hunk (git writes nothing else inside one), and may start the next.
    oldRemaining = 0;
    newRemaining = 0;
    const match = line.match(HUNK_HEADER);
    if (!match) continue;
    oldLine = parseInt(match[1]!, 10);
    newLine = parseInt(match[3]!, 10);
    oldRemaining = parseInt(match[2] ?? "1", 10);
    newRemaining = parseInt(match[4] ?? "1", 10);
    hunk = {
      oldStart: oldLine,
      oldLines: oldRemaining,
      newStart: newLine,
      newLines: newRemaining,
      header: line,
      lines: [],
    };
    hunks.push(hunk);
  }

  return hunks;
}

function lineType(line: string): DiffLine["type"] | null {
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "delete";
  // git writes an empty context line as "" rather than " " with diff.suppressBlankEmpty.
  if (line.startsWith(" ") || line === "") return "normal";
  return null;
}
