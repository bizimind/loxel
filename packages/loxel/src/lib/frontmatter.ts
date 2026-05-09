/**
 * Frontmatter detection and manipulation for markdown files.
 *
 * Detection is strict positional: the file must start with `---\n` and have
 * a matching `\n---\n` (or `\n---` at EOF). No YAML validation is performed.
 */

interface FrontmatterSplit {
  /** YAML content between the `---` delimiters, or null if no frontmatter detected. */
  frontmatter: string | null;
  /** Markdown body after the closing `---` delimiter. */
  body: string;
}

const OPENING = "---\n";

/**
 * Split a markdown string into frontmatter and body.
 * Returns `{ frontmatter: null, body: content }` when no frontmatter is detected.
 */
export function splitFrontmatter(content: string): FrontmatterSplit {
  if (!content.startsWith(OPENING)) {
    return { frontmatter: null, body: content };
  }

  // Search for the closing delimiter after the opening `---\n`
  const searchStart = OPENING.length;
  const closingIdx = content.indexOf("\n---", searchStart);

  if (closingIdx === -1) {
    return { frontmatter: null, body: content };
  }

  const frontmatter = content.slice(searchStart, closingIdx);

  // Body starts after `\n---\n` — or is empty if the closing `---` is at EOF
  const afterClosing = closingIdx + 4; // "\n---".length
  let body: string;
  if (afterClosing >= content.length) {
    body = "";
  } else if (content[afterClosing] === "\n") {
    // Strip the blank line separator between frontmatter and body (if present)
    // so mergeFrontmatter can always re-add it consistently.
    const bodyStart = afterClosing + 1;
    body = content[bodyStart] === "\n" ? content.slice(bodyStart + 1) : content.slice(bodyStart);
  } else {
    // Closing `---` is not followed by newline or EOF — not valid frontmatter
    return { frontmatter: null, body: content };
  }

  return { frontmatter, body };
}

/**
 * Merge frontmatter and body back into a full markdown string.
 * If `frontmatter` is null, returns `body` unchanged.
 */
export function mergeFrontmatter(frontmatter: string | null, body: string): string {
  if (frontmatter === null) return body;
  // Blank line separator between closing --- and body (matches Prettier).
  // When body is empty, omit the separator to avoid a trailing blank line.
  return body ? `---\n${frontmatter}\n---\n\n${body}` : `---\n${frontmatter}\n---\n`;
}
