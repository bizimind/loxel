/**
 * EditorConfig section globs: `*` (within a path segment), `**` (across segments), `?`, `[chars]`,
 * `[!chars]`, `{a,b}`, `{n1..n2}` and `\` escapes. Braces are expanded up front into flat token
 * sequences, which are matched with a table over (token, path position) rather than a
 * backtracking regex: a cloned repository's `.editorconfig` must not be able to stall the server.
 */

type Token =
  | { kind: "char"; char: string }
  /** `?`: one character other than `/`. */
  | { kind: "one" }
  /** `*`: any run of characters other than `/`. */
  | { kind: "star" }
  /** `**`: any run of characters. */
  | { kind: "globstar" }
  /** `**` followed by `/`: zero or more whole directories. */
  | { kind: "dirs" }
  | { kind: "class"; negated: boolean; ranges: Array<[string, string]> }
  /** `{n1..n2}`: an integer between the bounds. */
  | { kind: "number"; low: number; high: number };

type Node = Token | { kind: "alt"; options: Node[][] };

/** The token sequences a section glob's braces expand to; empty matches nothing. */
export type SectionGlob = Token[][];

/**
 * Bounds on a section's expansion, far beyond any real `.editorconfig`: past them the section
 * matches nothing. Matching costs tokens x path length, so the total token count is what bounds
 * the time a crafted file can take.
 */
const MAX_ALTERNATIVES = 256;
const MAX_TOTAL_TOKENS = 4096;

/**
 * Compile a section name. A glob without `/` matches the file name in any directory below the
 * `.editorconfig`; one with a `/` is anchored at that directory (a leading `/` only marks it so).
 */
export function compileSectionGlob(glob: string): SectionGlob {
  const anchored = glob.includes("/") ? glob.replace(/^\//, "") : `**/${glob}`;
  return expand(parse(anchored)) ?? [];
}

/** Whether a compiled glob matches a path relative to the `.editorconfig`'s directory. */
export function globMatches(glob: SectionGlob, path: string): boolean {
  return glob.some((tokens) => matchTokens(tokens, path));
}

function parse(glob: string): Node[] {
  const nodes: Node[] = [];
  const char = (c: string) => nodes.push({ kind: "char", char: c });
  let i = 0;
  while (i < glob.length) {
    const c = glob[i]!;
    if (c === "\\" && i + 1 < glob.length) {
      char(glob[i + 1]!);
      i += 2;
    } else if (c === "*" && glob[i + 1] === "*") {
      // Only a whole `**` segment may match zero directories; `c**/z.c` still needs its `/`.
      const dirs = glob[i + 2] === "/" && (i === 0 || glob[i - 1] === "/");
      nodes.push({ kind: dirs ? "dirs" : "globstar" });
      i += dirs ? 3 : 2;
    } else if (c === "*" || c === "?") {
      nodes.push({ kind: c === "*" ? "star" : "one" });
      i++;
    } else if (c === "[") {
      const end = closingBracket(glob, i);
      if (end === -1) {
        char(c);
        i++;
      } else {
        nodes.push(parseClass(glob.slice(i + 1, end)));
        i = end + 1;
      }
    } else if (c === "{") {
      const end = closingBrace(glob, i);
      if (end === -1) {
        char(c);
        i++;
        continue;
      }
      const body = glob.slice(i + 1, end);
      const range = /^([+-]?\d+)\.\.([+-]?\d+)$/.exec(body);
      const alternatives = splitAlternatives(body);
      if (range) {
        const [a, b] = [Number(range[1]), Number(range[2])];
        nodes.push({ kind: "number", low: Math.min(a, b), high: Math.max(a, b) });
      } else if (alternatives.length < 2) {
        // A brace without a comma or range is literal.
        char("{");
        nodes.push(...parse(body));
        char("}");
      } else {
        nodes.push({ kind: "alt", options: alternatives.map(parse) });
      }
      i = end + 1;
    } else {
      char(c);
      i++;
    }
  }
  return nodes;
}

/** Index of the `]` closing the class opened at `start`, or -1 (then `[` is literal). */
function closingBracket(glob: string, start: number): number {
  for (let j = start + 1; j < glob.length; j++) {
    const c = glob[j];
    if (c === "\\") j++;
    else if (c === "/") return -1;
    else if (c === "]" && j > start + 1) return j;
  }
  return -1;
}

function parseClass(body: string): Token {
  const negated = body.startsWith("!") || body.startsWith("^");
  const chars: Array<{ char: string; escaped: boolean }> = [];
  for (let j = negated ? 1 : 0; j < body.length; j++) {
    const escaped = body[j] === "\\" && j + 1 < body.length;
    if (escaped) j++;
    chars.push({ char: body[j]!, escaped });
  }
  const ranges: Array<[string, string]> = [];
  for (let k = 0; k < chars.length; k++) {
    const from = chars[k]!.char;
    const dash = chars[k + 1];
    const to = chars[k + 2];
    if (dash?.char === "-" && !dash.escaped && to) {
      ranges.push([from, to.char]);
      k += 2;
    } else {
      ranges.push([from, from]);
    }
  }
  return { kind: "class", negated, ranges };
}

/** Index of the `}` matching the `{` at `start`, honoring nesting and escapes, or -1. */
function closingBrace(glob: string, start: number): number {
  let depth = 0;
  for (let j = start; j < glob.length; j++) {
    const c = glob[j];
    if (c === "\\") j++;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return j;
  }
  return -1;
}

/** Split a brace body on its top-level commas. */
function splitAlternatives(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let j = 0; j < body.length; j++) {
    const c = body[j];
    if (c === "\\") j++;
    else if (c === "{") depth++;
    else if (c === "}") depth--;
    else if (c === "," && depth === 0) {
      parts.push(body.slice(start, j));
      start = j + 1;
    }
  }
  parts.push(body.slice(start));
  return parts;
}

/** Expand alternatives into flat token sequences, or null past `MAX_ALTERNATIVES`. */
function expand(nodes: Node[]): Token[][] | null {
  let sequences: Token[][] = [[]];
  for (const node of nodes) {
    if (node.kind !== "alt") {
      for (const sequence of sequences) sequence.push(node);
      continue;
    }
    const options: Token[][] = [];
    for (const option of node.options) {
      const expanded = expand(option);
      // Checked as options accumulate, so a huge expansion is rejected before it is built.
      if (!expanded || sequences.length * (options.length + expanded.length) > MAX_ALTERNATIVES) {
        return null;
      }
      options.push(...expanded);
    }
    sequences = sequences.flatMap((sequence) => options.map((option) => [...sequence, ...option]));
    if (totalTokens(sequences) > MAX_TOTAL_TOKENS) return null;
  }
  return totalTokens(sequences) > MAX_TOTAL_TOKENS ? null : sequences;
}

function totalTokens(sequences: Token[][]): number {
  return sequences.reduce((sum, sequence) => sum + sequence.length, 0);
}

/**
 * Match from the last token back: `next[i]` says whether the tokens after the current one match
 * `path.slice(i)`, so each token costs one pass over the path.
 */
function matchTokens(tokens: Token[], path: string): boolean {
  const n = path.length;
  let next = new Uint8Array(n + 2);
  next[n] = 1;
  for (let t = tokens.length - 1; t >= 0; t--) {
    const token = tokens[t]!;
    const row = new Uint8Array(n + 2);
    // For `dirs`: whether some `/` at or after the position ends a match of the rest.
    let slashAhead = false;
    for (let i = n; i >= 0; i--) {
      const c = path[i];
      let matched: boolean;
      switch (token.kind) {
        case "char":
          matched = c === token.char && next[i + 1] === 1;
          break;
        case "one":
          matched = c !== undefined && c !== "/" && next[i + 1] === 1;
          break;
        case "class":
          matched = c !== undefined && classMatches(token, c) && next[i + 1] === 1;
          break;
        case "star":
          matched = next[i] === 1 || (c !== undefined && c !== "/" && row[i + 1] === 1);
          break;
        case "globstar":
          matched = next[i] === 1 || (c !== undefined && row[i + 1] === 1);
          break;
        case "dirs":
          if (c === "/" && next[i + 1] === 1) slashAhead = true;
          matched = next[i] === 1 || slashAhead;
          break;
        case "number":
          matched = numberMatches(token, path, i, next);
          break;
        default: {
          const unknown: never = token;
          throw new Error(`Unknown glob token ${JSON.stringify(unknown)}`);
        }
      }
      row[i] = matched ? 1 : 0;
    }
    next = row;
  }
  return next[0] === 1;
}

function classMatches(token: Extract<Token, { kind: "class" }>, c: string): boolean {
  const listed = token.ranges.some(([from, to]) => c >= from && c <= to);
  return token.negated ? c !== "/" && !listed : listed;
}

function numberMatches(
  token: Extract<Token, { kind: "number" }>,
  path: string,
  start: number,
  next: Uint8Array,
): boolean {
  let end = path[start] === "+" || path[start] === "-" ? start + 1 : start;
  // Zero-padded numbers are not matched: `{3..120}` does not match `060`, as in every core.
  const second = path[end + 1];
  if (path[end] === "0" && second !== undefined && second >= "0" && second <= "9") return false;
  while (end < path.length && path[end]! >= "0" && path[end]! <= "9") {
    end++;
    const value = Number(path.slice(start, end));
    if (value >= token.low && value <= token.high && next[end] === 1) return true;
  }
  return false;
}
