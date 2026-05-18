import { useEffect, useRef, useState } from "react";

import type { FileDiff } from "@/api/diff-model";
import { detectLanguage, escapeHtml, highlightCode, type HighlightedLine } from "@/lib/highlighter";
import { useUIStore } from "@/store/ui";

export interface HighlightedHunk {
  header: string;
  lines: Array<{
    type: "normal" | "add" | "delete";
    content: string;
    html: string;
    oldLineNumber?: number;
    newLineNumber?: number;
  }>;
}

export interface HighlightedFile {
  hunks: HighlightedHunk[];
}

/**
 * Hook to get syntax-highlighted diff content.
 * Returns highlighted HTML for each line, falling back to plain text while loading.
 */
export function useSyntaxHighlight(file: FileDiff | null): HighlightedFile | null {
  const darkMode = useUIStore((s) => s.darkMode);
  const [highlighted, setHighlighted] = useState<HighlightedFile | null>(null);
  const currentFileRef = useRef<string | null>(null);

  useEffect(() => {
    if (!file || file.isBinary) {
      setHighlighted(null);
      currentFileRef.current = null;
      return;
    }

    const filePath = file.newPath || file.oldPath;

    // Reset if file changed
    if (filePath !== currentFileRef.current) {
      setHighlighted(null);
      currentFileRef.current = filePath;
    }

    const language = detectLanguage(filePath);
    if (!language) {
      // No language detected, return plain text
      setHighlighted({
        hunks: file.hunks.map((hunk) => ({
          header: hunk.header,
          lines: hunk.lines.map((line) => ({
            type: line.type,
            content: line.content,
            html: escapeHtml(line.content),
            oldLineNumber: line.oldLineNumber,
            newLineNumber: line.newLineNumber,
          })),
        })),
      });
      return;
    }

    const theme = darkMode ? "github-dark" : "github-light";
    const lang = language; // Capture for async closure
    let cancelled = false;

    // Highlight each hunk
    async function highlightHunks() {
      if (!file) return;

      const highlightedHunks: HighlightedHunk[] = [];

      for (const hunk of file.hunks) {
        // Build the code block from all lines for context
        const codeLines = hunk.lines.map((l) => l.content);
        const code = codeLines.join("\n");

        let lineHtmls: HighlightedLine[];
        try {
          lineHtmls = await highlightCode(code, lang, theme);
        } catch {
          // Fallback to plain text
          lineHtmls = codeLines.map((line) => ({ html: escapeHtml(line) }));
        }

        // Check if cancelled before continuing
        if (cancelled) return;

        highlightedHunks.push({
          header: hunk.header,
          lines: hunk.lines.map((line, i) => ({
            type: line.type,
            content: line.content,
            html: lineHtmls[i]?.html ?? escapeHtml(line.content),
            oldLineNumber: line.oldLineNumber,
            newLineNumber: line.newLineNumber,
          })),
        });
      }

      if (!cancelled) {
        setHighlighted({ hunks: highlightedHunks });
      }
    }

    highlightHunks();

    return () => {
      cancelled = true;
    };
  }, [file, darkMode]);

  return highlighted;
}
