import type { CommentThread, DiffFileContext, PlacedThread } from "@/api/review-model";
import { relocateAnchor } from "@/lib/content-anchor";

import * as git from "./git-commands";

/** Read file content for a given ref/worktree, returning lines array */
async function readFileContent(
  cwd: string,
  filePath: string,
  ref: string | null,
  worktreePath?: string,
): Promise<string[]> {
  if (!ref && worktreePath) {
    return git.getWorkingTreeFileContent(cwd, worktreePath, filePath);
  }
  if (ref) {
    return git.getFileContent(cwd, filePath, ref);
  }
  return [];
}

interface FileContentCache {
  oldLines: Map<string, string[]>;
  newLines: Map<string, string[]>;
}

/**
 * Place threads against file content by running content-anchor relocation.
 *
 * For each thread:
 * 1. Try relocateAnchor() against the created_side's content first
 * 2. If "lost", try the other side
 * 3. Build PlacedThread with displaySide, anchorStatus, line numbers
 * 4. If "outdated": include originalContent + currentContent
 */
export async function placeThreads(
  cwd: string,
  threads: CommentThread[],
  files: DiffFileContext[],
): Promise<PlacedThread[]> {
  if (threads.length === 0) return [];

  // Build a map of file paths → DiffFileContext for quick lookup
  const fileByPath = new Map<string, DiffFileContext>();
  for (const file of files) {
    fileByPath.set(file.oldPath, file);
    fileByPath.set(file.newPath, file);
  }

  // Collect unique file+ref pairs to read (deduplicated)
  const contentCache: FileContentCache = { oldLines: new Map(), newLines: new Map() };

  // Prefetch all file contents in parallel
  const readPromises: Promise<void>[] = [];

  for (const file of files) {
    const oldKey = `${file.oldRef ?? "null"}:${file.oldPath}`;
    if (!contentCache.oldLines.has(oldKey)) {
      contentCache.oldLines.set(oldKey, []); // placeholder to prevent double-read
      readPromises.push(
        readFileContent(cwd, file.oldPath, file.oldRef, file.worktreePath).then(
          (lines) => {
            contentCache.oldLines.set(oldKey, lines);
          },
          () => {
            contentCache.oldLines.set(oldKey, []);
          },
        ),
      );
    }

    const newKey = `${file.newRef ?? "null"}:${file.newPath}`;
    if (!contentCache.newLines.has(newKey)) {
      contentCache.newLines.set(newKey, []); // placeholder
      readPromises.push(
        readFileContent(cwd, file.newPath, file.newRef, file.worktreePath).then(
          (lines) => {
            contentCache.newLines.set(newKey, lines);
          },
          () => {
            contentCache.newLines.set(newKey, []);
          },
        ),
      );
    }
  }

  await Promise.all(readPromises);

  // Place each thread
  const placed: PlacedThread[] = [];

  for (const thread of threads) {
    const file = fileByPath.get(thread.filePath);
    if (!file) {
      // Thread's file not in the current diff — mark as lost
      placed.push({
        ...thread,
        displaySide: thread.createdSide,
        displayStartLine: thread.startLine,
        displayEndLine: thread.endLine,
        anchorStatus: "lost",
      });
      continue;
    }

    const oldKey = `${file.oldRef ?? "null"}:${file.oldPath}`;
    const newKey = `${file.newRef ?? "null"}:${file.newPath}`;
    const oldLines = contentCache.oldLines.get(oldKey) ?? [];
    const newLines = contentCache.newLines.get(newKey) ?? [];

    const primaryLines = thread.createdSide === "old" ? oldLines : newLines;
    const secondaryLines = thread.createdSide === "old" ? newLines : oldLines;
    const secondarySide: "old" | "new" = thread.createdSide === "old" ? "new" : "old";

    // Try primary side first
    const primary = relocateAnchor(thread.contentAnchor, primaryLines, thread.startLine);

    if (primary.status !== "lost") {
      const placedThread: PlacedThread = {
        ...thread,
        displaySide: thread.createdSide,
        displayStartLine: primary.startLine,
        displayEndLine: primary.endLine,
        anchorStatus: primary.status,
      };

      if (primary.status === "outdated") {
        placedThread.originalContent = thread.contentAnchor.content;
        placedThread.currentContent = primaryLines.slice(primary.startLine - 1, primary.endLine);
      }

      placed.push(placedThread);
      continue;
    }

    // Primary side lost — try secondary side
    const secondary = relocateAnchor(thread.contentAnchor, secondaryLines, thread.startLine);

    if (secondary.status !== "lost") {
      const placedThread: PlacedThread = {
        ...thread,
        displaySide: secondarySide,
        displayStartLine: secondary.startLine,
        displayEndLine: secondary.endLine,
        anchorStatus: secondary.status,
      };

      if (secondary.status === "outdated") {
        placedThread.originalContent = thread.contentAnchor.content;
        placedThread.currentContent = secondaryLines.slice(
          secondary.startLine - 1,
          secondary.endLine,
        );
      }

      placed.push(placedThread);
      continue;
    }

    // Both sides lost
    placed.push({
      ...thread,
      displaySide: thread.createdSide,
      displayStartLine: thread.startLine,
      displayEndLine: thread.endLine,
      anchorStatus: "lost",
    });
  }

  return placed;
}
