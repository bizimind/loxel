import type { editor } from "monaco-editor";

import type { PlacedThread } from "@/api/review-model";

/**
 * Build Monaco decorations for placed comment threads.
 * Each thread gets a background highlight over its display line range.
 * Uses anchorStatus to style outdated anchors differently.
 */
export function buildCommentDecorations(
  threads: PlacedThread[],
  side: "old" | "new",
): editor.IModelDeltaDecoration[] {
  const decorations: editor.IModelDeltaDecoration[] = [];

  for (const thread of threads) {
    if (thread.displaySide !== side) continue;

    const isResolved = thread.status === "resolved";
    let className: string;
    if (thread.anchorStatus === "outdated") {
      className = "comment-highlight-outdated";
    } else if (isResolved) {
      className = "comment-highlight-resolved";
    } else {
      className = "comment-highlight";
    }

    decorations.push({
      range: {
        startLineNumber: thread.displayStartLine,
        startColumn: 1,
        endLineNumber: thread.displayEndLine,
        endColumn: 1,
      },
      options: { isWholeLine: true, className },
    });
  }

  return decorations;
}
