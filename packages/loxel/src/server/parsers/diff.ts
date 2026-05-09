import type { DiffHunk, DiffInfo, FileDiff } from "@/api/diff-model";

/**
 * Parse unified diff output from git diff.
 */
export function parseDiffOutput(output: string): DiffInfo {
  const files: FileDiff[] = [];

  if (!output.trim()) {
    return { files };
  }

  // Split by diff headers
  const diffPattern = /^diff --git/gm;
  const parts = output.split(diffPattern).filter(Boolean);

  for (const part of parts) {
    const file = parseFileDiff("diff --git" + part);
    if (file) {
      files.push(file);
    }
  }

  return { files };
}

/**
 * Parse a single file diff.
 */
function parseFileDiff(content: string): FileDiff | null {
  const lines = content.split("\n");
  const firstLine = lines[0];
  if (!firstLine) return null;

  // Parse header: diff --git a/path b/path
  const headerMatch = firstLine.match(/^diff --git a\/(.+) b\/(.+)$/);
  if (!headerMatch) return null;

  const oldPath = headerMatch[1] ?? "";
  const newPath = headerMatch[2] ?? "";

  // Detect status and binary
  let status: FileDiff["status"] = "modified";
  let isBinary = false;

  for (const line of lines.slice(1, 10)) {
    if (line.startsWith("new file mode")) {
      status = "added";
    } else if (line.startsWith("deleted file mode")) {
      status = "deleted";
    } else if (line.startsWith("rename from")) {
      status = "renamed";
    } else if (line.startsWith("copy from")) {
      status = "copied";
    } else if (line.startsWith("Binary files")) {
      isBinary = true;
    }
  }

  // Parse hunks
  const hunks: DiffHunk[] = [];
  let additions = 0;
  let deletions = 0;

  if (!isBinary) {
    const hunkPattern = /^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@(.*)$/;
    let currentHunk: DiffHunk | null = null;
    let oldLine = 0;
    let newLine = 0;

    for (const line of lines) {
      const hunkMatch = line.match(hunkPattern);
      if (hunkMatch) {
        if (currentHunk) {
          hunks.push(currentHunk);
        }
        oldLine = parseInt(hunkMatch[1] ?? "1", 10);
        newLine = parseInt(hunkMatch[3] ?? "1", 10);
        currentHunk = {
          oldStart: oldLine,
          oldLines: parseInt(hunkMatch[2] ?? "1", 10),
          newStart: newLine,
          newLines: parseInt(hunkMatch[4] ?? "1", 10),
          header: line,
          lines: [],
        };
      } else if (currentHunk) {
        if (line.startsWith("+") && !line.startsWith("+++")) {
          currentHunk.lines.push({ type: "add", content: line.slice(1), newLineNumber: newLine++ });
          additions++;
        } else if (line.startsWith("-") && !line.startsWith("---")) {
          currentHunk.lines.push({
            type: "delete",
            content: line.slice(1),
            oldLineNumber: oldLine++,
          });
          deletions++;
        } else if (line.startsWith(" ")) {
          currentHunk.lines.push({
            type: "normal",
            content: line.slice(1),
            oldLineNumber: oldLine++,
            newLineNumber: newLine++,
          });
        } else if (line === "\\ No newline at end of file") {
          // Keep as-is, no line number change
          currentHunk.lines.push({ type: "normal", content: line });
        }
      }
    }

    if (currentHunk) {
      hunks.push(currentHunk);
    }
  }

  return { oldPath, newPath, status, hunks, isBinary, additions, deletions };
}
