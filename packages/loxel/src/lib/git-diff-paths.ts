/** Paths in git diff headers, which git C-quotes when they hold unusual characters. */

/**
 * Read the two paths from a `diff --git a/<old> b/<new>` header.
 *
 * Git C-quotes a path containing a double quote, a control character or a non-ASCII byte, and
 * does so per side: `diff --git a/plain.txt "b/\303\274.txt"` is a valid header. Unquoted
 * paths may contain spaces, and even ` b/`, so an all-unquoted header is read as the same path on
 * both sides when it can be (every change but a rename or copy, whose `rename`/`copy` lines name
 * the paths), and is otherwise split on its last ` b/` separator.
 */
export function parseGitHeaderPaths(line: string): { oldPath: string; newPath: string } | null {
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
  } else if (isSamePathTwice(rest)) {
    const half = (rest.length - 1) / 2;
    oldToken = rest.slice(0, half);
    newToken = rest.slice(half + 1);
  } else {
    const match = rest.match(/^(a\/.+) (b\/.+)$/);
    if (!match) return null;
    oldToken = match[1]!;
    newToken = match[2]!;
  }

  if (!oldToken.startsWith("a/") || !newToken.startsWith("b/")) return null;
  return { oldPath: oldToken.slice(2), newPath: newToken.slice(2) };
}

/** Whether `rest` is `a/<path> b/<path>` with the same path on both sides. */
function isSamePathTwice(rest: string): boolean {
  if (rest.length % 2 === 0) return false;
  const half = (rest.length - 1) / 2;
  return (
    rest.startsWith("a/") &&
    rest[half] === " " &&
    rest.slice(half + 1, half + 3) === "b/" &&
    rest.slice(2, half) === rest.slice(half + 3)
  );
}

/** A path value of a git extended header (`rename from <path>`), C-quoted by git when unusual. */
export function gitPathValue(value: string): string {
  return (value.startsWith('"') ? unquoteCString(value, 0)?.value : undefined) ?? value;
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
export function unquoteCString(text: string, start: number): { value: string; end: number } | null {
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
