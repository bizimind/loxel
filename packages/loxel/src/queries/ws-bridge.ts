import { useEffect } from "react";

import * as api from "@/api/client";
import { wsClient } from "@/api/client";
import type { WsMessage } from "@/api/ws-protocol";
import { frontendLog } from "@/lib/frontend-logger";
import { dispatchLoxelEvent } from "@/lib/loxel-events";
import { openFile, openFolder, openTerminal } from "@/lib/open-path";
import { handleFileMoved } from "@/lib/panel-creators";
import { consumeSavedContent } from "@/lib/save-editor-content";
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

import { isWorkingTreeDiffKey, queryKeys, workingTreeFileContentKey } from "./query-keys";

const log = frontendLog.child("files");

/**
 * Apply a `file_content_changed` event to a file open in an editor: clean editors refresh their
 * query (or take the stashed content of their own write), dirty ones go through the state machine.
 */
export function refreshOpenFile(
  projectPath: string | null,
  wtPath: string,
  path: string,
  nonces: string[],
): void {
  const editorStore = useEditorStateStore.getState();
  const entry = editorStore.files.get(path);
  // A moved file's tab is being replaced; the old path no longer concerns it.
  if (!entry || entry.movedTo) return;

  const queryKey = queryKeys.fileContent(projectPath, path, undefined, wtPath);
  // Content from the file-write response (matched by nonce) saves an HTTP round-trip.
  let stashedContent: string | undefined;
  for (const n of nonces) {
    stashedContent = consumeSavedContent(n);
    if (stashedContent !== undefined) break;
  }

  // A file marked deleted needs its content run through the state machine, which clears the
  // flag: a clean editor's refetch alone may not (identical content keeps the same query data).
  if (entry.state === "clean" && !entry.deleted) {
    for (const n of nonces) {
      if (entry.pendingNonces.has(n)) editorStore.clearPendingNonce(path, n);
    }
    if (stashedContent !== undefined) {
      // Duplicate FS event from our own write: update the cache instead of refetching.
      queryClient.setQueryData(queryKey, { content: stashedContent });
    } else {
      // The refetch also tells the editor whether the file still exists (404 → deleted).
      queryClient.invalidateQueries({ queryKey: queryKeys.fileContentPrefix(projectPath, path) });
    }
    return;
  }

  if (stashedContent !== undefined) {
    // If the matched nonces are superseded (a newer save is still pending), the stashed
    // content is stale — the latest write has already overwritten disk. Hand it to the state
    // machine (which short-circuits) but don't put the stale value in the query cache.
    const matchedNonces = nonces.filter((n) => entry.pendingNonces.has(n));
    const superseded = matchedNonces.length > 0 && entry.pendingNonces.size > matchedNonces.length;
    editorStore.handleDiskChange(path, nonces, stashedContent);
    if (!superseded) queryClient.setQueryData(queryKey, { content: stashedContent });
    return;
  }

  void fetchIntoOpenFile(projectPath, wtPath, path, nonces);
}

/**
 * Fetch the current disk content of a non-clean open file and run it through the state machine.
 * A 404 means the file was deleted: the editor keeps its content, autosave stops, and the next
 * event for the path (restore or re-create) brings it back through the same function.
 */
async function fetchIntoOpenFile(
  projectPath: string | null,
  wtPath: string,
  path: string,
  nonces: string[],
): Promise<void> {
  const editorStore = useEditorStateStore.getState();
  const queryKey = queryKeys.fileContent(projectPath, path, undefined, wtPath);
  try {
    const data = await api.getFileContentByPath(path, wtPath);
    editorStore.handleDiskChange(path, nonces, data.content);
    await applyFetchedContent(queryKey, data);
  } catch (error: unknown) {
    if (api.isFileMissingError(error)) {
      editorStore.setDeleted(path, true);
      return;
    }
    log.error("Failed to refresh editor after external file change", {
      error,
      path,
      projectPath,
      worktreePath: wtPath,
    });
  }
}

/**
 * Re-check whether an open file still exists after its parent directory changed. Marks it
 * deleted on a confirmed 404; if it was deleted and is back, feeds the content to the state
 * machine like an external restore. A file that exists and was not deleted is left alone.
 */
export async function checkOpenFileExists(
  projectPath: string | null,
  wtPath: string,
  path: string,
): Promise<void> {
  if (useEditorStateStore.getState().files.get(path)?.movedTo) return;
  try {
    const data = await api.getFileContentByPath(path, wtPath);
    // Read the entry after the fetch: another request (e.g. the editor's own refetch) may have
    // marked it deleted, or a move may have started, while this one was in flight.
    const entry = useEditorStateStore.getState().files.get(path);
    if (!entry?.deleted || entry.movedTo) return;
    useEditorStateStore.getState().handleDiskChange(path, [], data.content);
    await applyFetchedContent(queryKeys.fileContent(projectPath, path, undefined, wtPath), data);
  } catch (error: unknown) {
    if (api.isFileMissingError(error)) {
      useEditorStateStore.getState().setDeleted(path, true);
      return;
    }
    log.error("Failed to check an open file after its directory changed", {
      error,
      path,
      projectPath,
      worktreePath: wtPath,
    });
  }
}

/**
 * Put freshly fetched content in the query cache. An older refetch still in flight (e.g. from
 * an invalidation) is cancelled first, so it cannot land a stale 404 after the file is back.
 */
async function applyFetchedContent(
  queryKey: ReturnType<typeof queryKeys.fileContent>,
  data: { content: string },
): Promise<void> {
  await queryClient.cancelQueries({ queryKey, exact: true });
  queryClient.setQueryData(queryKey, data);
}

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
          // Refetch working-tree diffs (uncommitted changes may have changed). This fires on
          // every edit, so commit/range diffs — immutable — are deliberately left alone.
          // File content (editors and the diff view's working-tree side) is handled per-file
          // by file_content_changed events — no need to invalidate all fileContent queries on
          // every status change.
          queryClient.invalidateQueries({
            predicate: (query) => isWorkingTreeDiffKey(query.queryKey, projectPath),
          });
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
          const projectPath = deriveProjectPath(message.wtPath);

          // The diff view reads the new side of an uncommitted diff from disk, keyed by the
          // worktree-relative path, whether or not the file is open in an editor.
          const diffContentKey = workingTreeFileContentKey(
            projectPath,
            message.wtPath,
            changedPath,
          );
          if (diffContentKey) {
            queryClient.invalidateQueries({ queryKey: diffContentKey, exact: true });
          }

          const openPaths = useEditorStateStore.getState().files.keys();
          for (const openPath of openPaths) {
            if (openPath === changedPath) {
              refreshOpenFile(projectPath, message.wtPath, openPath, nonces);
            } else if (openPath.startsWith(changedPath + "/")) {
              // A removed or re-created directory is reported as one event for the directory,
              // not for the files inside it. Only their existence can have changed (a modified
              // file reports itself), so just re-check that.
              void checkOpenFileExists(projectPath, message.wtPath, openPath);
            }
          }
          break;
        }

        case "file_moved": {
          const { oldPath, newPath, source } = message.data;
          // Moves done in Loxel are also reported here so every window's tabs follow them;
          // the window that made the move has usually handled it already (a no-op then).
          // Only a move from outside Loxel is announced in the editor.
          void handleFileMoved(oldPath, newPath, { announce: source === "external" });
          break;
        }

        case "worktree_files_resynced": {
          const { projectPath } = message;
          const editorStore = useEditorStateStore.getState();
          queryClient.invalidateQueries({
            queryKey: queryKeys.status(projectPath, message.wtPath),
          });
          queryClient.invalidateQueries({ queryKey: queryKeys.worktreeStatuses(projectPath) });
          queryClient.invalidateQueries({ queryKey: ["diff", projectPath] });
          queryClient.invalidateQueries({ queryKey: ["dirContents", projectPath] });
          queryClient.invalidateQueries({
            predicate: (query) => {
              const key = query.queryKey;
              return (
                key[0] === "fileContent" &&
                key[1] === projectPath &&
                key[3] === undefined &&
                key[4] === message.wtPath
              );
            },
          });
          queryClient.invalidateQueries({
            queryKey: queryKeys.detachedFiles(projectPath, message.wtPath),
          });
          queryClient.invalidateQueries({
            queryKey: queryKeys.externalFiles(projectPath, message.wtPath),
          });

          // A broad query invalidation refreshes clean editors. Dirty/saving editors
          // need the same conflict-aware state-machine path as a normal file event.
          for (const [path, entry] of editorStore.files) {
            if (entry.state === "clean") continue;
            const queryKey = queryKeys.fileContent(projectPath, path, undefined, message.wtPath);
            if (!queryClient.getQueryCache().find({ queryKey, exact: true })) continue;
            void fetchIntoOpenFile(projectPath, message.wtPath, path, []);
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
          void openFile(message.data.filePath);
          break;

        case "open_folder":
          void openFolder(message.data.path);
          break;

        case "open_terminal":
          void openTerminal(message.data);
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
          // A commit or reset moves what uncommitted/staged diffs compare against. Commit and
          // range diffs are keyed by SHA; an amend or rebase yields new SHAs, hence new keys.
          queryClient.invalidateQueries({
            predicate: (query) => isWorkingTreeDiffKey(query.queryKey, message.projectPath),
          });
          // Worktree statuses need no refetch here: the server re-sweeps them on the same git
          // event and pushes the result as worktree_status_changed.
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
        case "terminal_state":
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
      wsClient.disconnect();
    };
  }, []);
}

/** Derive project path from a worktree path using the project store. */
function deriveProjectPath(wtPath: string): string | null {
  const projects = useProjectStore.getState().projects;
  return deriveProject(wtPath, projects)?.path ?? null;
}
