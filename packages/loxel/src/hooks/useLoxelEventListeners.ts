/**
 * Registers all loxel custom event listeners for panel creation and file lifecycle.
 *
 * All handlers call module-level functions from lib/panel-creators.ts,
 * so the effect has no dependencies and no stale closure risk.
 */
import { useEffect } from "react";

import { onLoxelEvent } from "@/lib/loxel-events";
import {
  createBrowser,
  createCodeEditor,
  createDrawing,
  createEditor,
  createTerminal,
  duplicateComparison,
  handleFileDeleted,
  handleFileMoved,
  openCompareFiles,
  openDiff,
  openLocalDb,
  openFileBacked,
} from "@/lib/panel-creators";
import { usePanelNotificationStore } from "@/store/panel-notifications";

export function useLoxelEventListeners(): void {
  useEffect(() => {
    const cleanups = [
      // A CustomEvent dispatched without a detail carries null, which the default parameter does not cover.
      onLoxelEvent("loxel-create-terminal", (d) => createTerminal(d ?? {})),
      onLoxelEvent("loxel-create-editor", (d) => createEditor({ placement: d?.placement })),
      onLoxelEvent("loxel-create-drawing", (d) => createDrawing(d?.placement)),
      onLoxelEvent("loxel-create-browser", (d) => createBrowser(d?.url, d ?? {})),
      onLoxelEvent("loxel-create-code-editor", (d) =>
        createCodeEditor({ ext: d?.ext, placement: d?.placement }),
      ),
      onLoxelEvent("loxel-create-editor-with-content", (d) =>
        createEditor({ content: d.content, title: d.title }),
      ),
      onLoxelEvent("loxel-open-code-editor", (d) =>
        openFileBacked("codeEditor", d.filePath, {
          params: { line: d.line, column: d.column },
          placement: d.placement,
          focus: d.focus,
        }),
      ),
      onLoxelEvent("loxel-open-markdown-editor", (d) =>
        openFileBacked("editor", d.filePath, {
          params: { line: d.line, column: d.column },
          placement: d.placement,
          focus: d.focus,
        }),
      ),
      onLoxelEvent("loxel-open-drawing-editor", (d) =>
        openFileBacked("excalidraw", d.filePath, { placement: d.placement, focus: d.focus }),
      ),
      onLoxelEvent("loxel-open-media-viewer", (d) =>
        openFileBacked("media", d.filePath, { placement: d.placement, focus: d.focus }),
      ),
      onLoxelEvent("loxel-open-diff", () => openDiff()),
      onLoxelEvent("loxel-compare-files", (d) =>
        "oldPath" in d ? openCompareFiles(d.oldPath, d.newPath) : duplicateComparison(d.placement),
      ),
      onLoxelEvent("loxel-open-localdb", () => openLocalDb()),
      onLoxelEvent("loxel-file-moved", (d) => void handleFileMoved(d.oldPath, d.newPath)),
      onLoxelEvent("loxel-file-deleted", (d) => handleFileDeleted(d.filePath)),
    ];

    // Listen for Electron IPC: Cmd+click on external links opens in browser panel tab.
    const removeIpc = window.electronAPI?.onOpenInBrowserTab((url) => createBrowser(url));

    // Sync notification count to macOS dock badge
    let prevBadgeCount = -1;
    const removeDockBadge = window.electronAPI
      ? usePanelNotificationStore.subscribe((s) => {
          const count = s.notifications.length;
          if (count !== prevBadgeCount) {
            prevBadgeCount = count;
            window.electronAPI?.setDockBadge(count);
          }
        })
      : undefined;

    return () => {
      for (const cleanup of cleanups) cleanup();
      removeIpc?.();
      removeDockBadge?.();
    };
  }, []);
}
