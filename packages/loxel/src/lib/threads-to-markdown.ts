import type { PlacedThread } from "@/api/review-model";

interface ThreadsToMarkdownOptions {
  reviewNames: string[];
  placedThreadsByFile: Map<string, PlacedThread[]>;
  lostThreads: PlacedThread[];
}

/**
 * Convert review comment threads into a formatted markdown document.
 * Designed for human readability and AI agent consumption (file paths, line numbers, code context).
 *
 * Single-author optimization: when all comments share one author, author names and
 * timestamps are omitted. First comment renders as plain text, replies as blockquotes.
 * Multi-author mode: each comment is prefixed with **AuthorName:**.
 */
export function threadsToMarkdown(options: ThreadsToMarkdownOptions): string {
  const { reviewNames, placedThreadsByFile, lostThreads } = options;
  const lines: string[] = [];

  const allThreads = collectAllThreads(placedThreadsByFile, lostThreads);
  if (allThreads.length === 0) return "# Review Comments\n\nNo comments.\n";

  const singleAuthor = isSingleAuthor(allThreads);
  const { openCount, resolvedCount } = countByStatus(allThreads);
  const allFiles = new Set(placedThreadsByFile.keys());
  for (const t of lostThreads) allFiles.add(t.filePath);
  const fileCount = allFiles.size;

  // Header
  lines.push("# Review Comments");
  lines.push("");
  if (reviewNames.length > 0) {
    lines.push(`**Reviews:** ${reviewNames.join(", ")}`);
  }
  const parts: string[] = [];
  if (openCount > 0) parts.push(`${openCount} open`);
  if (resolvedCount > 0) parts.push(`${resolvedCount} resolved`);
  lines.push(
    `**Summary:** ${parts.join(", ")} across ${fileCount} file${fileCount !== 1 ? "s" : ""}`,
  );
  lines.push("");
  lines.push("---");

  // Placed threads grouped by file
  const sortedFiles = [...placedThreadsByFile.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  for (const [filePath, threads] of sortedFiles) {
    if (threads.length === 0) continue;
    lines.push("");
    lines.push(`## \`${filePath}\``);
    const sorted = sortThreads(threads);
    for (const thread of sorted) {
      lines.push("");
      renderThread(lines, thread, singleAuthor);
      lines.push("");
      lines.push("---");
    }
  }

  // Lost threads
  if (lostThreads.length > 0) {
    lines.push("");
    lines.push("## Lost Comments");
    lines.push("");
    lines.push("> These comments could not be anchored to the current code.");
    for (const thread of lostThreads) {
      lines.push("");
      renderLostThread(lines, thread, singleAuthor);
      lines.push("");
      lines.push("---");
    }
  }

  // Remove trailing "---" if it's the last line
  while (lines.length > 0 && lines[lines.length - 1] === "---") {
    lines.pop();
  }

  lines.push("");
  return lines.join("\n");
}

function renderThread(lines: string[], thread: PlacedThread, singleAuthor: boolean): void {
  const lineRange =
    thread.displayEndLine > thread.displayStartLine
      ? `Lines ${thread.displayStartLine}-${thread.displayEndLine}`
      : `Line ${thread.displayStartLine}`;

  const status = thread.status === "resolved" ? "RESOLVED" : "OPEN";
  const anchorNote =
    thread.anchorStatus !== "exact" && thread.anchorStatus !== "lost"
      ? ` [${thread.anchorStatus}]`
      : "";

  lines.push(`### ${lineRange} -- ${status}${anchorNote}`);

  // Outdated notice
  if (thread.anchorStatus === "outdated") {
    lines.push("");
    lines.push("> Note: The code at this location has changed since the comment was made.");
  }

  // Code context
  if (thread.contentAnchor.content.length > 0) {
    const lang = inferLanguage(thread.filePath);
    lines.push("");
    lines.push(`\`\`\`${lang}`);
    for (const codeLine of thread.contentAnchor.content) {
      lines.push(codeLine);
    }
    lines.push("```");
  }

  // Comments
  renderComments(lines, thread, singleAuthor);
}

function renderLostThread(lines: string[], thread: PlacedThread, singleAuthor: boolean): void {
  const lineRange =
    thread.endLine > thread.startLine
      ? `Lines ${thread.startLine}-${thread.endLine}`
      : `Line ${thread.startLine}`;

  lines.push(`### \`${thread.filePath}\` -- ${lineRange}`);

  // Code context from anchor
  if (thread.contentAnchor.content.length > 0) {
    const lang = inferLanguage(thread.filePath);
    lines.push("");
    lines.push(`\`\`\`${lang}`);
    for (const codeLine of thread.contentAnchor.content) {
      lines.push(codeLine);
    }
    lines.push("```");
  }

  renderComments(lines, thread, singleAuthor);
}

function renderComments(lines: string[], thread: PlacedThread, singleAuthor: boolean): void {
  for (let i = 0; i < thread.comments.length; i++) {
    const comment = thread.comments[i]!;
    lines.push("");

    if (singleAuthor) {
      // Single author: first comment as plain text, replies as blockquotes
      if (i === 0) {
        lines.push(comment.body);
      } else {
        for (const bodyLine of comment.body.split("\n")) {
          lines.push(bodyLine ? `> ${bodyLine}` : ">");
        }
      }
    } else {
      // Multi-author: prefix each with bold author name
      const author = comment.authorName ?? "Anonymous";
      lines.push(`**${author}:**`);
      lines.push(comment.body);
    }
  }
}

/** Sort threads: open first, then by start line within each status group. */
function sortThreads(threads: PlacedThread[]): PlacedThread[] {
  return [...threads].sort((a, b) => {
    const statusOrder = a.status === b.status ? 0 : a.status === "open" ? -1 : 1;
    if (statusOrder !== 0) return statusOrder;
    return a.displayStartLine - b.displayStartLine;
  });
}

/** Check if all comments across all threads are from the same author. */
function isSingleAuthor(threads: PlacedThread[]): boolean {
  let author: string | null | undefined;
  for (const thread of threads) {
    for (const comment of thread.comments) {
      if (author === undefined) {
        author = comment.authorName;
      } else if (comment.authorName !== author) {
        return false;
      }
    }
  }
  return true;
}

function countByStatus(threads: PlacedThread[]): { openCount: number; resolvedCount: number } {
  let openCount = 0;
  let resolvedCount = 0;
  for (const thread of threads) {
    if (thread.status === "resolved") resolvedCount++;
    else openCount++;
  }
  return { openCount, resolvedCount };
}

function collectAllThreads(
  placedThreadsByFile: Map<string, PlacedThread[]>,
  lostThreads: PlacedThread[],
): PlacedThread[] {
  const all: PlacedThread[] = [];
  for (const threads of placedThreadsByFile.values()) {
    all.push(...threads);
  }
  all.push(...lostThreads);
  return all;
}

const EXTENSION_LANGUAGE: Record<string, string> = {
  ts: "typescript",
  tsx: "tsx",
  js: "javascript",
  jsx: "jsx",
  py: "python",
  rb: "ruby",
  go: "go",
  rs: "rust",
  java: "java",
  kt: "kotlin",
  swift: "swift",
  css: "css",
  scss: "scss",
  html: "html",
  json: "json",
  yaml: "yaml",
  yml: "yaml",
  md: "markdown",
  sql: "sql",
  sh: "bash",
  zsh: "bash",
  c: "c",
  cpp: "cpp",
  h: "c",
  hpp: "cpp",
  cs: "csharp",
  php: "php",
  toml: "toml",
  xml: "xml",
  graphql: "graphql",
  gql: "graphql",
};

function inferLanguage(filePath: string): string {
  const ext = filePath.split(".").pop()?.toLowerCase();
  return ext ? (EXTENSION_LANGUAGE[ext] ?? "") : "";
}
