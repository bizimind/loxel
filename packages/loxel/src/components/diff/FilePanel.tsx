import type { RefObject } from "react";
import { useEffect, useMemo, useState } from "react";

import { detectLanguage, highlightCode } from "@/lib/highlighter";
import { cn } from "@/lib/utils";
import { useUIStore } from "@/store/ui";

import type { ChangeRegion, ChangeType } from "./change-regions";
import { buildLineChangeMap } from "./change-regions";

function getRowBgClass(changeType: ChangeType | undefined): string {
  switch (changeType) {
    case "modify":
      return "bg-diff-modify-bg";
    case "delete":
      return "bg-diff-del-bg";
    case "add":
      return "bg-diff-add-bg";
    case undefined:
      return "";
    default: {
      const _exhaustive: never = changeType;
      throw new Error(`Unknown ChangeType: ${String(_exhaustive)}`);
    }
  }
}

function getGutterTextClass(changeType: ChangeType | undefined): string {
  switch (changeType) {
    case "modify":
      return "text-diff-modify-text";
    case "delete":
      return "text-diff-del-text";
    case "add":
      return "text-diff-add-text";
    case undefined:
      return "";
    default: {
      const _exhaustive: never = changeType;
      throw new Error(`Unknown ChangeType: ${String(_exhaustive)}`);
    }
  }
}

interface FilePanelProps {
  lines: string[];
  changeRegions: ChangeRegion[];
  side: "old" | "new";
  lineHeight: number;
  filePath: string;
  /** Ref for the content wrapper, used for CSS transform-based scroll sync */
  contentRef?: RefObject<HTMLDivElement | null>;
}

/**
 * FilePanel renders the code content (without line numbers).
 * Line numbers are rendered by LineNumbersPanel in a separate non-scrolling container.
 */
export function FilePanel({
  lines,
  changeRegions,
  side,
  lineHeight,
  filePath,
  contentRef,
}: FilePanelProps) {
  const darkMode = useUIStore((s) => s.darkMode);
  const [highlightedLines, setHighlightedLines] = useState<string[] | null>(null);

  // Build a map of line number -> change type for O(1) lookup
  const lineChangeMap = useMemo(() => buildLineChangeMap(changeRegions), [changeRegions]);

  // Syntax highlight the code
  useEffect(() => {
    const language = detectLanguage(filePath);
    if (!language || lines.length === 0) {
      setHighlightedLines(null);
      return;
    }

    let cancelled = false;
    const theme = darkMode ? "github-dark" : "github-light";
    const code = lines.join("\n");

    highlightCode(code, language, theme)
      .then((result) => {
        if (!cancelled) {
          setHighlightedLines(result.map((r) => r.html));
        }
      })
      .catch(() => {
        if (!cancelled) {
          setHighlightedLines(null);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [lines, filePath, darkMode]);

  if (lines.length === 0) {
    return (
      <div className="text-muted-foreground flex h-full items-center justify-center text-xs">
        {side === "old" ? "File does not exist in parent" : "File was deleted"}
      </div>
    );
  }

  return (
    <div ref={contentRef} className="will-change-transform">
      <table className="w-full border-separate border-spacing-0 font-mono text-xs">
        <tbody>
          {lines.map((line, idx) => {
            const lineNum = idx + 1;
            const changeType = lineChangeMap.get(lineNum);
            const highlightedHtml = highlightedLines?.[idx];
            const codeBgClass = getRowBgClass(changeType);

            return (
              <tr key={lineNum} data-line={lineNum} style={{ height: lineHeight }}>
                <td className={cn("px-2 whitespace-pre", codeBgClass)}>
                  {highlightedHtml ? (
                    <span dangerouslySetInnerHTML={{ __html: highlightedHtml }} />
                  ) : (
                    line
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

interface LineNumbersPanelProps {
  lines: string[];
  changeRegions: ChangeRegion[];
  side: "old" | "new";
  lineHeight: number;
}

/**
 * LineNumbersPanel renders line numbers in a separate container.
 * This container doesn't scroll horizontally - it receives vertical transforms
 * from useSyncScroll to stay in sync with the code content.
 */
export function LineNumbersPanel({
  lines,
  changeRegions,
  side,
  lineHeight,
}: LineNumbersPanelProps) {
  // Build a map of line number -> change type for O(1) lookup
  const lineChangeMap = useMemo(() => buildLineChangeMap(changeRegions), [changeRegions]);

  if (lines.length === 0) {
    return null;
  }

  return (
    <table className="w-full border-separate border-spacing-0 font-mono text-xs">
      <tbody>
        {lines.map((_, idx) => {
          const lineNum = idx + 1;
          const changeType = lineChangeMap.get(lineNum);
          const gutterTextClass = getGutterTextClass(changeType);

          return (
            <tr key={lineNum} style={{ height: lineHeight }}>
              <td
                className={cn(
                  "text-muted-foreground/50 w-12 select-none",
                  side === "old" ? "px-4 text-left" : "px-4 text-right",
                  gutterTextClass,
                )}
              >
                {lineNum}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
