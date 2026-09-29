import type { DiffHunk, FileDiff } from "@/api/diff-model";

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

  // Split by diff headers
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

  const paths = parseHeaderPaths(firstLine);
  if (!paths) return null;
  const { oldPath, newPath } = paths;

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

/**
 * Read the two paths from a `diff --git a/<old> b/<new>` header.
 *
 * Git C-quotes a path containing a double quote, a control character or a non-ASCII byte, and
 * does so per side: `diff --git a/plain.txt "b/\303\274.txt"` is a valid header. Unquoted
 * paths may contain spaces, so an all-unquoted header is split on its ` b/` separator.
 */
function parseHeaderPaths(line: string): { oldPath: string; newPath: string } | null {
  const prefix = "diff --git ";
  if (!line.startsWith(prefix)) return null;
  const rest = line.slice(prefix.length);

  let oldToken: string;
  let newToken: string;
  if (rest.startsWith('"')) {
    const quoted = unquoteCString(rest, 0);
    if (!quoted || rest[quoted.end] !== " ") return null;
    oldToken = quoted.value;
    const remainder = rest.slice(quoted.end + 1);
    const quotedNew = remainder.startsWith('"') ? unquoteCString(remainder, 0) : null;
    newToken = quotedNew ? quotedNew.value : remainder;
  } else if (rest.endsWith('"') && rest.includes(' "b/')) {
    const separator = rest.lastIndexOf(' "b/');
    const quotedNew = unquoteCString(rest, separator + 1);
    if (!quotedNew) return null;
    oldToken = rest.slice(0, separator);
    newToken = quotedNew.value;
  } else {
    const match = rest.match(/^(a\/.+) (b\/.+)$/);
    if (!match) return null;
    oldToken = match[1]!;
    newToken = match[2]!;
  }

  if (!oldToken.startsWith("a/") || !newToken.startsWith("b/")) return null;
  return { oldPath: oldToken.slice(2), newPath: newToken.slice(2) };
}

const C_ESCAPES: Record<string, number> = {
  a: 7,
  b: 8,
  f: 12,
  n: 10,
  r: 13,
  t: 9,
  v: 11,
  '"': 34,
  "\\": 92,
};

/**
 * Decode the C-style quoted string starting at `start` (which must be `"`), as git writes it:
 * backslash escapes plus three-digit octal escapes for the raw bytes of a UTF-8 name.
 */
function unquoteCString(text: string, start: number): { value: string; end: number } | null {
  if (text[start] !== '"') return null;
  const bytes: number[] = [];
  const encoder = new TextEncoder();
  for (let i = start + 1; i < text.length; i++) {
    const char = text[i]!;
    if (char === '"') {
      return { value: new TextDecoder().decode(new Uint8Array(bytes)), end: i + 1 };
    }
    if (char !== "\\") {
      bytes.push(...encoder.encode(char));
      continue;
    }
    const next = text[++i];
    if (next === undefined) return null;
    const octal = text.slice(i, i + 3);
    if (/^[0-7]{3}$/.test(octal)) {
      bytes.push(parseInt(octal, 8));
      i += 2;
    } else if (next in C_ESCAPES) {
      bytes.push(C_ESCAPES[next]!);
    } else {
      bytes.push(...encoder.encode(next));
    }
  }
  return null;
}
