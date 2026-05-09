import { useEffect } from "react";

import type { WsMessage } from "@/api/ws-protocol";

import * as api from "@/api/client";
import { wsClient } from "@/api/client";
import { dispatchLoxelEvent } from "@/lib/loxel-events";
import { dispatchOpenFile } from "@/lib/open-file";
import { consumeSavedContent } from "@/lib/save-editor-content";
import { initTerminalNotificationScanner } from "@/lib/terminal-notification-scanner";
import { queryClient } from "@/query-client";
import { useEditorStateStore } from "@/store/editor-state";
import { useLogStore } from "@/store/logs";
import { usePanelBadgeStore } from "@/store/panel-badges";
import { usePanelNotificationStore } from "@/store/panel-notifications";
import { deriveProject, useProjectStore } from "@/store/projects";
import { consumeNonce } from "@/store/server-storage";
import { applyStoreUpdate } from "@/store/store-sync";
import { getCurrentWorktreeToolsBar } from "@/store/worktree-tools-bar";
import { useWorktreeStore } from "@/store/worktrees";

import { queryKeys } from "./query-keys";

/**
 * Bridges WebSocket messages to TanStack React Query cache operations.
 *
 * Messages carry their scope (wtPath or projectPath) so the bridge
 * routes updates to the correct cache entries without relying on
 * any global "active" state.
 */
export function useWsBridge(): void {
  useEffect(() => {
    wsClient.connect();
    const unsubNotifScanner = initTerminalNotificationScanner(wsClient);

    // On reconnect, invalidate update status so React Query refetches from the (new) server.
    // This clears the stale "installing" state when the version didn't change (failed update
    // fallback) — if the version DID change, the WsClient reloads the page instead.
    const unsubReconnect = wsClient.onReconnect(() => {
      queryClient.invalidateQueries({ queryKey: queryKeys.updateStatus() });
    });

    const getLogsIsActive = (): boolean => {
      const { activeLeftPanel, activeBottomPanel, activeRightPanel } =
        getCurrentWorktreeToolsBar().getState();
      return (
        activeLeftPanel === "logs" || activeBottomPanel === "logs" || activeRightPanel === "logs"
      );
    };

    const unsubscribe = wsClient.subscribe((message: WsMessage) => {
      switch (message.type) {
        // --- Worktree-scoped events (carry wtPath) ---

        case "status_changed": {
          const projectPath = deriveProjectPath(message.wtPath);
          queryClient.setQueryData(queryKeys.status(projectPath, message.wtPath), message.data);
          // Refetch diffs (uncommitted changes may have changed).
          // File content is handled per-file by file_content_changed events —
          // no need to invalidate all fileContent queries on every status change.
          queryClient.invalidateQueries({ queryKey: ["diff", projectPath] });
          break;
        }

        case "files_dir_changed": {
          const projectPath = deriveProjectPath(message.wtPath);
          queryClient.setQueryData(
            queryKeys.dirContents(projectPath, message.data.dir),
            message.data.entries,
          );
          dispatchLoxelEvent("loxel-dir-changed", { dir: message.data.dir });
          break;
        }

        case "file_content_changed": {
          const { path: changedPath, nonces } = message.data;
          const editorStore = useEditorStateStore.getState();
          const entry = editorStore.files.get(changedPath);
          if (!entry) break;

          const projectPath = deriveProjectPath(message.wtPath);
          const prefixKey = queryKeys.fileContentPrefix(projectPath, changedPath);
          if (entry.state === "clean") {
            for (const n of nonces) {
              if (entry.pendingNonces.has(n)) editorStore.clearPendingNonce(changedPath, n);
            }
            // Check for stashed content (duplicate FS event from our own write).
            // If found, update cache directly instead of invalidating (which refetches).
            let cleanStashed: string | undefined;
            for (const n of nonces) {
              cleanStashed = consumeSavedContent(n);
              if (cleanStashed !== undefined) break;
            }
            if (cleanStashed !== undefined) {
              const queryKey = queryKeys.fileContent(
                projectPath,
                changedPath,
                undefined,
                message.wtPath,
              );
              queryClient.setQueryData(queryKey, { content: cleanStashed });
            } else {
              queryClient.invalidateQueries({ queryKey: prefixKey });
            }
          } else {
            // Try to use stashed content from the file-write response (matched by nonce)
            // to avoid an extra HTTP round-trip.
            let stashedContent: string | undefined;
            for (const n of nonces) {
              stashedContent = consumeSavedContent(n);
              if (stashedContent !== undefined) break;
            }

            const queryKey = queryKeys.fileContent(
              projectPath,
              changedPath,
              undefined,
              message.wtPath,
            );

            // If the matched nonces are superseded (a newer save is still pending),
            // the stashed content is stale — the latest write has already overwritten
            // disk. Hand it to the state machine (which will short-circuit) but don't
            // update the query cache with a stale value; invalidate for a fresh fetch
            // when we eventually need it.
            const matchedNonces = nonces.filter((n) => entry.pendingNonces.has(n));
            const superseded =
              matchedNonces.length > 0 && entry.pendingNonces.size > matchedNonces.length;

            if (stashedContent !== undefined) {
              editorStore.handleDiskChange(changedPath, nonces, stashedContent);
              if (!superseded) {
                queryClient.setQueryData(queryKey, { content: stashedContent });
              }
            } else {
              // External change (no matching nonce) — must fetch from server
              api
                .getFileContentByPath(changedPath, message.wtPath)
                .then((data) => {
                  editorStore.handleDiskChange(changedPath, nonces, data.content);
                  queryClient.setQueryData(queryKey, data);
                })
                .catch(() => {});
            }
          }
          break;
        }

        case "detached_files_changed": {
          const projectPath = deriveProjectPath(message.wtPath);
          queryClient.setQueryData(
            queryKeys.detachedFiles(projectPath, message.wtPath),
            message.data.entries,
          );
          break;
        }

        case "external_files_changed": {
          const projectPath = deriveProjectPath(message.wtPath);
          queryClient.setQueryData(
            queryKeys.externalFiles(projectPath, message.wtPath),
            message.data.entries,
          );
          break;
        }

        case "open_file":
          dispatchOpenFile(message.data.filePath);
          break;

        case "open_url":
          window.dispatchEvent(
            new CustomEvent("loxel-create-browser", { detail: { url: message.data.url } }),
          );
          break;

        // --- Project-scoped events (carry projectPath) ---

        case "worktree_status_changed":
          queryClient.setQueryData(queryKeys.worktreeStatuses(message.projectPath), message.data);
          break;

        case "refs_changed":
        case "log_changed":
          queryClient.invalidateQueries({ queryKey: ["commits", message.projectPath] });
          queryClient.invalidateQueries({ queryKey: ["branchCommits", message.projectPath] });
          // Refetch diffs — commit amends / rebases change diff content
          queryClient.invalidateQueries({ queryKey: ["diff", message.projectPath] });
          if (message.type === "log_changed") {
            queryClient.invalidateQueries({
              queryKey: queryKeys.worktreeStatuses(message.projectPath),
            });
          }
          break;

        case "worktrees_changed": {
          // Refresh worktrees for the specific project that changed
          useWorktreeStore.getState().refreshProjectWorktrees(message.data.projectPath);
          break;
        }

        case "localdb_changed": {
          const { projectPath } = message;
          queryClient.invalidateQueries({ queryKey: ["localdb", projectPath, "tables"] });
          if (message.data.tableName) {
            queryClient.invalidateQueries({
              queryKey: ["localdb", projectPath, "schema", message.data.tableName],
            });
          }
          if (message.data.tableId !== undefined) {
            queryClient.invalidateQueries({
              queryKey: ["localdb", projectPath, "views", message.data.tableId],
            });
          }
          queryClient.invalidateQueries({ queryKey: ["localdb", projectPath] });
          dispatchLoxelEvent("loxel-localdb-changed", {
            projectPath,
            tableName: message.data.tableName,
            tableId: message.data.tableId,
            scope: message.data.scope,
          });
          break;
        }

        // --- Global events ---

        case "log_entries":
          useLogStore.getState().addLiveEntries(message.data);
          break;

        case "log_error_count": {
          const badges = usePanelBadgeStore.getState();
          if (getLogsIsActive()) {
            // Panel is open — user is seeing these live. Keep `lastSeenErrorTotal`
            // in sync with the server's running total so a future snapshot
            // (on reconnect) compares against the right baseline.
            badges.advanceSeenByDelta(message.delta);
          } else {
            badges.increment("logs", message.delta);
          }
          break;
        }

        case "log_error_snapshot": {
          usePanelBadgeStore.getState().reconcileLogsFromSnapshot(message.total, getLogsIsActive());
          break;
        }

        case "update_status_changed":
          queryClient.setQueryData(queryKeys.updateStatus(), message.data);
          break;

        // --- Notification events (global) ---

        case "notifications_sync":
          usePanelNotificationStore.getState().syncAll(message.data);
          break;
        case "notification_added":
          usePanelNotificationStore.getState().addFromServer(message.data);
          break;
        case "notification_dismissed":
          usePanelNotificationStore.getState().removeFromServer(message.id);
          break;
        case "notification_panel_dismissed":
          usePanelNotificationStore.getState().removePanelFromServer(message.panelId);
          break;
        case "notifications_cleared":
          usePanelNotificationStore.getState().clearFromServer();
          break;

        case "store_updated":
          if (message.nonce && consumeNonce(message.nonce)) break;
          applyStoreUpdate(message.key, message.state);
          break;

        case "terminal_exit":
        case "error":
        case "agent_event":
        case "agent_exit":
        case "agent_sessions":
        case "agent_replay_done":
        case "agent_error":
          break;

        default: {
          const _exhaustive: never = message;
          throw new Error(
            `Unknown ws message type: ${String((_exhaustive as { type?: unknown }).type)}`,
          );
        }
      }
    });

    return () => {
      unsubReconnect();
      unsubscribe();
      unsubNotifScanner();
      wsClient.disconnect();
    };
  }, []);
}

/** Derive project path from a worktree path using the project store. */
function deriveProjectPath(wtPath: string): string | null {
  const projects = useProjectStore.getState().projects;
  return deriveProject(wtPath, projects)?.path ?? null;
}
