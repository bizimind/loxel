/** One `key = value` of a git config file, under the section it appears in. */
export interface GitConfigEntry {
  /** The section's name, lower-cased as git does, dots kept (`filter`, `filter.a`, `includeif`). */
  section: string;
  /** The quoted subsection, as written; undefined without one. */
  subsection: string | undefined;
  /** Lower-cased. */
  key: string;
  /** Null for a key with no `=`, which git reads as true. */
  value: string | null;
}

const GIT_SPACE = new Set([" ", "\t", "\n", "\r"]);
const isKeyChar = (char: string) => /^[A-Za-z0-9-]$/.test(char);

/**
 * The entries of a git config file's text, read the way git's own parser (`git_parse_source` in
 * git's `config.c`) reads it, so what counts as a section header or a value is git's answer: a
 * `[` opens a section only where an entry could start, and a value runs to the end of its line
 * with quotes, escapes, comments and backslash continuations as git takes them. Null where git
 * stops with "bad config line", since git then reads nothing either. `text` is a byte string.
 */
export function parseGitConfig(text: string): GitConfigEntry[] | null {
  let i = text.startsWith("\xEF\xBB\xBF") ? 3 : 0;
  /** The next character with `\r\n` as `\n`, and `\n` at the end, as git's `get_next_char`. */
  const next = (): string => {
    if (i >= text.length) {
      i++;
      return "\n";
    }
    const char = text[i++]!;
    if (char === "\r" && text[i] === "\n") return text[i++]!;
    return char;
  };
  const atEnd = () => i > text.length;
  const entries: GitConfigEntry[] = [];
  let section: string | null = null;
  let subsection: string | undefined;
  let comment = false;
  for (;;) {
    const char = next();
    if (atEnd()) return entries;
    if (char === "\n") {
      comment = false;
      continue;
    }
    if (comment || GIT_SPACE.has(char)) continue;
    if (char === "#" || char === ";") {
      comment = true;
      continue;
    }
    if (char === "[") {
      const header = readHeader(next, atEnd);
      if (!header) return null;
      ({ section, subsection } = header);
      continue;
    }
    if (!/^[A-Za-z]$/.test(char) || section === null) return null;
    const entry = readEntry(char, next);
    if (!entry) return null;
    entries.push({ section, subsection, ...entry });
  }
}

/** `[base]` or `[base "sub"]` after its `[`, as git's `get_base_var`. */
function readHeader(
  next: () => string,
  atEnd: () => boolean,
): { section: string; subsection: string | undefined } | null {
  let base = "";
  for (;;) {
    const char = next();
    if (atEnd()) return null;
    if (char === "]") return { section: base, subsection: undefined };
    if (GIT_SPACE.has(char)) {
      if (char === "\n") return null;
      let after = next();
      while (GIT_SPACE.has(after)) {
        if (after === "\n") return null;
        after = next();
      }
      if (after !== '"') return null;
      let subsection = "";
      for (;;) {
        let sub = next();
        if (sub === "\n") return null;
        if (sub === '"') break;
        if (sub === "\\") {
          sub = next();
          if (sub === "\n") return null;
        }
        subsection += sub;
      }
      return next() === "]" ? { section: base, subsection } : null;
    }
    if (!isKeyChar(char) && char !== ".") return null;
    base += char.toLowerCase();
  }
}

/** A key starting with `first` and its value, as git's `get_value` and `parse_value`. */
function readEntry(
  first: string,
  next: () => string,
): { key: string; value: string | null } | null {
  let key = first.toLowerCase();
  let char = next();
  while (isKeyChar(char)) {
    key += char.toLowerCase();
    char = next();
  }
  while (char === " " || char === "\t") char = next();
  if (char === "\n") return { key, value: null };
  if (char !== "=") return null;
  let value = "";
  let quote = false;
  let comment = false;
  let spaces = 0;
  for (;;) {
    char = next();
    if (char === "\n") return quote ? null : { key, value };
    if (comment) continue;
    if (GIT_SPACE.has(char) && !quote) {
      if (value) spaces++;
      continue;
    }
    if (!quote && (char === ";" || char === "#")) {
      comment = true;
      continue;
    }
    value += " ".repeat(spaces);
    spaces = 0;
    if (char === "\\") {
      char = next();
      if (char === "\n") continue;
      const escaped = { t: "\t", b: "\b", n: "\n", "\\": "\\", '"': '"' }[char];
      if (escaped === undefined) return null;
      value += escaped;
      continue;
    }
    if (char === '"') {
      quote = !quote;
      continue;
    }
    value += char;
  }
}
