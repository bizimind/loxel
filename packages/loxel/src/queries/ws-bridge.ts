import { useEffect } from "react";

import * as api from "@/api/client";
import type { WsClient } from "@/api/client";
import { HOME_KEY } from "@/api/home-model";
import { localServerId } from "@/api/local-server";
import { connections, isFileMissingError } from "@/api/server-connection";
import { isToolchainChangedMessage } from "@/api/toolchain-status-model";
import { toolchainStatuses } from "@/api/toolchain-statuses";
import { type ServerId, type WorktreeRef, worktreeRef } from "@/api/worktree-ref";
import type { WsMessage } from "@/api/ws-protocol";
import { frontendLog } from "@/lib/frontend-logger";
import { dispatchLoxelEvent } from "@/lib/loxel-events";
import { dropInboxOpen, openFromInbox, openRequest } from "@/lib/open-path";
import { handleFileMoved } from "@/lib/panel-creators";
import { consumeSavedContent } from "@/lib/save-editor-content";
import { queryClient } from "@/query-client";
import { useAgentTerminalsStore } from "@/store/agent-terminals";
import { type EditorKey, useEditorStateStore } from "@/store/editor-state";
import { useLogStore } from "@/store/logs";
import { usePanelBadgeStore } from "@/store/panel-badges";
import { usePanelNotificationStore } from "@/store/panel-notifications";
import { projectRef, useProjectStore } from "@/store/projects";
import { useSchemaConsentStore } from "@/store/schema-consent";
import { consumeNonce } from "@/store/server-storage";
import { applyStoreUpdate } from "@/store/store-sync";
import { getCurrentWorktreeToolsBar } from "@/store/worktree-tools-bar";
import { useWorktreeStore } from "@/store/worktrees";

import {
  isDirContentsKeyBelow,
  isEditorConfigKeyBelow,
  isFileContentKey,
  isWorkingTreeDiffKey,
  isWorktreeDiskContentKey,
  queryKeys,
  workingTreeFileContentKey,
} from "./query-keys";
import { projectRefOf } from "./use-scope";

const log = frontendLog.child("files");
const serverLog = frontendLog.child("server");

const EDITORCONFIG_SUFFIX = "/.editorconfig";

/** Refetch the `.editorconfig` properties of open files under `dir` (ending in `/`; "" for all). */
function invalidateEditorConfigBelow(server: ServerId, dir: string): void {
  queryClient.invalidateQueries({
    predicate: ({ queryKey }) => isEditorConfigKeyBelow(queryKey, server, dir),
  });
}

/**
 * Apply a `file_content_changed` event to an open editor (`editorKey`, see `useEditorStateStore`):
 * clean editors refresh their query (or take the stashed content of their own write), dirty ones
 * go through the state machine.
 */
export function refreshOpenFile(
  project: WorktreeRef | null,
  wt: WorktreeRef | undefined,
  editorKey: EditorKey,
  nonces: string[],
): void {
  const editorStore = useEditorStateStore.getState();
  const entry = editorStore.files.get(editorKey);
  // A moved file's tab is being replaced; the old path no longer concerns it.
  if (!entry || entry.movedTo) return;
  const path = entry.filePath;

  const queryKey = queryKeys.fileContent(project, path, undefined, wt);
  // Content from the file-write response (matched by nonce) saves an HTTP round-trip.
  let stashedContent: string | undefined;
  for (const n of nonces) {
    stashedContent = consumeSavedContent(n, editorKey);
    if (stashedContent !== undefined) break;
  }

  // A file marked deleted needs its content run through the state machine, which clears the
  // flag: a clean editor's refetch alone may not (identical content keeps the same query data).
  if (entry.state === "clean" && !entry.deleted) {
    for (const n of nonces) {
      if (entry.pendingNonces.has(n)) editorStore.clearPendingNonce(editorKey, n);
    }
    if (stashedContent !== undefined) {
      // Duplicate FS event from our own write: update the cache instead of refetching.
      queryClient.setQueryData(queryKey, { content: stashedContent });
    } else {
      // The refetch also tells the editor whether the file still exists (404 → deleted).
      queryClient.invalidateQueries({ queryKey: queryKeys.fileContentPrefix(project, path) });
    }
    return;
  }

  if (stashedContent !== undefined) {
    // If the matched nonces are superseded (a newer save is still pending), the stashed
    // content is stale — the latest write has already overwritten disk. Hand it to the state
    // machine (which short-circuits) but don't put the stale value in the query cache.
    const matchedNonces = nonces.filter((n) => entry.pendingNonces.has(n));
    const superseded = matchedNonces.length > 0 && entry.pendingNonces.size > matchedNonces.length;
    editorStore.handleDiskChange(editorKey, nonces, stashedContent);
    if (!superseded) queryClient.setQueryData(queryKey, { content: stashedContent });
    return;
  }

  void fetchIntoOpenFile(project, wt, editorKey, entry.server, path, nonces);
}

/**
 * Fetch the current disk content of a non-clean open file and run it through the state machine.
 * A 404 means the file was deleted: the editor keeps its content, autosave stops, and the next
 * event for the path (restore or re-create) brings it back through the same function.
 */
async function fetchIntoOpenFile(
  project: WorktreeRef | null,
  wt: WorktreeRef | undefined,
  editorKey: EditorKey,
  server: ServerId,
  path: string,
  nonces: string[],
): Promise<void> {
  const editorStore = useEditorStateStore.getState();
  const queryKey = queryKeys.fileContent(project, path, undefined, wt);
  try {
    const data = await api.getFileContentByPath(server, path, wt);
    editorStore.handleDiskChange(editorKey, nonces, data.content);
    await applyFetchedContent(queryKey, data);
  } catch (error: unknown) {
    if (isFileMissingError(error)) {
      editorStore.setDeleted(editorKey, true);
      return;
    }
    log.error("Failed to refresh editor after external file change", {
      error,
      path,
      projectPath: project?.path ?? null,
      worktreePath: wt?.path,
    });
  }
}

/**
 * Re-check whether an open editor's file still exists after its parent directory changed. Marks
 * it deleted on a confirmed 404; if it was deleted and is back, feeds the content to the state
 * machine like an external restore. A file that exists and was not deleted is left alone.
 */
export async function checkOpenFileExists(
  project: WorktreeRef | null,
  wt: WorktreeRef | undefined,
  editorKey: EditorKey,
): Promise<void> {
  const initial = useEditorStateStore.getState().files.get(editorKey);
  if (!initial || initial.movedTo) return;
  const path = initial.filePath;
  try {
    const data = await api.getFileContentByPath(initial.server, path, wt);
    // Read the entry after the fetch: another request (e.g. the editor's own refetch) may have
    // marked it deleted, or a move may have started, while this one was in flight.
    const entry = useEditorStateStore.getState().files.get(editorKey);
    if (!entry?.deleted || entry.movedTo) return;
    useEditorStateStore.getState().handleDiskChange(editorKey, [], data.content);
    await applyFetchedContent(queryKeys.fileContent(project, path, undefined, wt), data);
  } catch (error: unknown) {
    if (isFileMissingError(error)) {
      useEditorStateStore.getState().setDeleted(editorKey, true);
      return;
    }
    log.error("Failed to check an open file after its directory changed", {
      error,
      path,
      projectPath: project?.path ?? null,
      worktreePath: wt?.path,
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
 * Bridges WebSocket messages to TanStack React Query cache operations, for every connection.
 *
 * Messages carry their scope (wtPath or projectPath) so the bridge
 * routes updates to the correct cache entries without relying on
 * any global "active" state. Their paths are on the server whose socket delivered them.
 */
export function useWsBridge(): void {
  useEffect(() => {
    const ends = connections().map((connection) => bridgeConnection(connection.ws));
    return () => {
      for (const end of ends) end();
    };
  }, []);
}

/** Connect one connection's socket and route what it delivers; returns the teardown. */
function bridgeConnection(ws: WsClient): () => void {
  ws.connect();

  const getLogsIsActive = (): boolean => {
    const { activeLeftPanel, activeBottomPanel, activeRightPanel } =
      getCurrentWorktreeToolsBar().getState();
    return (
      activeLeftPanel === "logs" || activeBottomPanel === "logs" || activeRightPanel === "logs"
    );
  };

  const unsubscribe = ws.subscribe((message: WsMessage, server: ServerId) => {
    // The window's own state and settings come from its own server alone (`localConnection`).
    const fromWindowServer = server === localServerId();
    if (isToolchainChangedMessage(message)) {
      const toolchain = toolchainStatuses.find((t) => t.changedMessage === message.type);
      if (!toolchain) return;
      const wt = worktreeRef(server, message.wtPath);
      void queryClient.invalidateQueries({
        queryKey: queryKeys.toolchainStatus(toolchain.id, projectRefOf(wt), wt),
      });
      dispatchLoxelEvent("loxel-toolchain-changed", { wt, changedMessage: message.type });
      return;
    }
    switch (message.type) {
      // --- Worktree-scoped events (carry wtPath) ---

      case "status_changed": {
        const wt = worktreeRef(server, message.wtPath);
        const project = projectRefOf(wt);
        queryClient.setQueryData(queryKeys.status(project, wt), message.data);
        // Refetch working-tree diffs (uncommitted changes may have changed). This fires on
        // every edit, so commit/range diffs — immutable — are deliberately left alone.
        // File content (editors and the diff view's working-tree side) is handled per-file
        // by file_content_changed events — no need to invalidate all fileContent queries on
        // every status change.
        queryClient.invalidateQueries({
          predicate: (query) => isWorkingTreeDiffKey(query.queryKey, project),
        });
        break;
      }

      case "files_dir_changed": {
        queryClient.setQueryData(
          queryKeys.dirContents(
            projectRefOf(worktreeRef(server, message.wtPath)),
            message.data.dir,
          ),
          message.data.entries,
        );
        dispatchLoxelEvent("loxel-dir-changed", { dir: message.data.dir });
        break;
      }

      case "file_content_changed": {
        const { path: changedPath, nonces } = message.data;
        const wt = worktreeRef(server, message.wtPath);
        const project = projectRefOf(wt);

        // The diff view reads the new side of an uncommitted diff from disk, keyed by the
        // worktree-relative path, whether or not the file is open in an editor.
        const diffContentKey = workingTreeFileContentKey(project, wt, changedPath);
        if (diffContentKey) {
          queryClient.invalidateQueries({ queryKey: diffContentKey, exact: true });
        }

        if (changedPath.endsWith(EDITORCONFIG_SUFFIX)) {
          invalidateEditorConfigBelow(
            server,
            changedPath.slice(0, -EDITORCONFIG_SUFFIX.length + 1),
          );
        }

        // Home's drafts belong to no worktree, like the editors that show them.
        const editorWt = message.wtPath === HOME_KEY ? undefined : wt;
        for (const [editorKey, entry] of useEditorStateStore.getState().files) {
          if (entry.server !== wt.server) continue;
          if (entry.filePath === changedPath) {
            refreshOpenFile(project, editorWt, editorKey, nonces);
          } else if (entry.filePath.startsWith(changedPath + "/")) {
            // A removed or re-created directory is reported as one event for the directory,
            // not for the files inside it. Only their existence can have changed (a modified
            // file reports itself), so just re-check that, and re-read the `.editorconfig`s
            // that may have come or gone with it.
            void checkOpenFileExists(project, editorWt, editorKey);
            queryClient.invalidateQueries({
              queryKey: queryKeys.editorConfigPrefix(server, entry.filePath),
            });
          }
        }
        break;
      }

      case "file_moved": {
        const { oldPath, newPath, source } = message.data;
        // Moves done in Loxel are also reported here so every window's tabs follow them;
        // the window that made the move has usually handled it already (a no-op then).
        // Only a move from outside Loxel is announced in the editor.
        void handleFileMoved(server, oldPath, newPath, { announce: source === "external" });
        break;
      }

      case "worktree_files_resynced": {
        const wt = worktreeRef(server, message.wtPath);
        const project = worktreeRef(server, message.projectPath);
        const editorStore = useEditorStateStore.getState();
        queryClient.invalidateQueries({ queryKey: queryKeys.status(project, wt) });
        queryClient.invalidateQueries({ queryKey: queryKeys.worktreeStatuses(project) });
        // Only this worktree's: commit and range diffs are keyed by SHA, so they cannot be stale.
        queryClient.invalidateQueries({
          predicate: ({ queryKey }) =>
            isWorkingTreeDiffKey(queryKey, project, wt) ||
            isDirContentsKeyBelow(queryKey, project, wt.path),
        });
        queryClient.invalidateQueries({
          predicate: ({ queryKey }) => isWorktreeDiskContentKey(queryKey, project, wt),
        });
        queryClient.invalidateQueries({ queryKey: queryKeys.detachedFiles(project, wt) });
        queryClient.invalidateQueries({ queryKey: queryKeys.externalFiles(project, wt) });
        // Covers the worktree's Others folders too, whose paths share no prefix with it.
        invalidateEditorConfigBelow(server, "");

        // A broad query invalidation refreshes clean editors. Dirty/saving editors
        // need the same conflict-aware state-machine path as a normal file event. Those with a
        // save queued are the save outbox's: its retry reads the file and merges it.
        for (const [editorKey, entry] of editorStore.files) {
          if (entry.server !== wt.server || entry.state === "clean" || entry.queued) continue;
          const path = entry.filePath;
          const queryKey = queryKeys.fileContent(project, path, undefined, wt);
          if (!queryClient.getQueryCache().find({ queryKey, exact: true })) continue;
          void fetchIntoOpenFile(project, wt, editorKey, entry.server, path, []);
        }
        // For what the cache does not hold: the files tree reads its listings imperatively, so
        // the invalidation above refreshes none of them, and the open files outside the
        // worktree are registered with the server again.
        dispatchLoxelEvent("loxel-worktree-files-resynced", { wt });
        break;
      }

      case "detached_files_changed": {
        const wt = worktreeRef(server, message.wtPath);
        queryClient.setQueryData(
          queryKeys.detachedFiles(projectRefOf(wt), wt),
          message.data.entries,
        );
        break;
      }

      case "external_files_changed": {
        const wt = worktreeRef(server, message.wtPath);
        queryClient.setQueryData(
          queryKeys.externalFiles(projectRefOf(wt), wt),
          message.data.entries,
        );
        break;
      }

      case "open_file":
      case "open_folder":
      case "open_terminal":
      case "open_url":
        void openRequest(server, message);
        break;

      case "open_from_inbox":
        void openFromInbox(server, message.inboxId, message.message);
        break;

      case "inbox_open_placed":
        dropInboxOpen(server, message.inboxId);
        break;

      // --- Project-scoped events (carry projectPath) ---

      case "worktree_status_changed":
        queryClient.setQueryData(
          queryKeys.worktreeStatuses(worktreeRef(server, message.projectPath)),
          message.data,
        );
        break;

      case "refs_changed":
      case "log_changed": {
        const project = worktreeRef(server, message.projectPath);
        queryClient.invalidateQueries({ queryKey: queryKeys.projectCommits(project) });
        queryClient.invalidateQueries({ queryKey: queryKeys.projectBranchCommits(project) });
        // Branches created, deleted or checked out outside Loxel (a terminal, an agent).
        if (message.type === "refs_changed") {
          queryClient.invalidateQueries({ queryKey: queryKeys.branches(project) });
        }
        // A commit or reset moves what uncommitted/staged diffs compare against. Commit and
        // range diffs are keyed by SHA; an amend or rebase yields new SHAs, hence new keys.
        queryClient.invalidateQueries({
          predicate: (query) => isWorkingTreeDiffKey(query.queryKey, project),
        });
        // Worktree statuses need no refetch here: the server re-sweeps them on the same git
        // event and pushes the result as worktree_status_changed.
        break;
      }

      case "worktrees_changed": {
        // Refresh worktrees for the specific project that changed
        useWorktreeStore
          .getState()
          .refreshProjectWorktrees(worktreeRef(server, message.data.projectPath));
        break;
      }

      case "localdb_changed": {
        const project = worktreeRef(server, message.projectPath);
        queryClient.invalidateQueries({ queryKey: queryKeys.localdbTables(project) });
        if (message.data.tableName) {
          queryClient.invalidateQueries({
            queryKey: queryKeys.localdbSchema(project, message.data.tableName),
          });
        }
        if (message.data.tableId !== undefined) {
          queryClient.invalidateQueries({
            queryKey: queryKeys.localdbViews(project, message.data.tableId),
          });
        }
        // The rows too, which every view of the project's tables shows.
        queryClient.invalidateQueries({ queryKey: queryKeys.localdb(project) });
        break;
      }

      // --- Global events ---

      case "log_entries":
        if (!fromWindowServer) break;
        useLogStore.getState().addLiveEntries(message.data);
        break;

      case "log_error_count": {
        if (!fromWindowServer) break;
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
        if (!fromWindowServer) break;
        usePanelBadgeStore.getState().reconcileLogsFromSnapshot(message.total, getLogsIsActive());
        break;
      }

      // --- Notification events (global) ---

      case "schema_consent_changed":
        if (!fromWindowServer) break;
        useSchemaConsentStore.setState(message.data);
        break;

      case "agent_terminals_changed":
        if (!fromWindowServer) break;
        useAgentTerminalsStore.setState(message.data);
        break;

      case "notifications_sync":
        usePanelNotificationStore.getState().syncAll(server, message.data);
        break;
      case "notification_added":
        usePanelNotificationStore.getState().addFromServer(server, message.data);
        break;
      case "notification_dismissed":
        usePanelNotificationStore.getState().removeFromServer(server, message.id);
        break;
      case "notification_panel_dismissed":
        usePanelNotificationStore.getState().removePanelFromServer(server, message.panelId);
        break;
      case "notifications_cleared":
        usePanelNotificationStore.getState().clearFromServer(server);
        break;

      case "repo_trust_changed":
        void queryClient.invalidateQueries({ queryKey: queryKeys.repoTrustAll() });
        // What a toolchain reports can depend on trust, such as a shim's version.
        void queryClient.invalidateQueries({ queryKey: queryKeys.toolchainStatusAll() });
        break;

      case "store_updated":
        if (!fromWindowServer) break;
        if (message.nonce && consumeNonce(message.nonce)) break;
        applyStoreUpdate(message.key, message.state);
        break;

      case "terminals_changed":
        void queryClient.invalidateQueries({ queryKey: queryKeys.runningTerminals(server) });
        break;

      case "server_hello": // handled by the WsClient itself
      case "terminal_exit":
      case "terminal_notice":
      case "terminal_state":
      case "terminal_size":
      case "error":
        break;

      default: {
        const _exhaustive: never = message;
        throw new Error(
          `Unknown ws message type: ${String((_exhaustive as { type?: unknown }).type)}`,
        );
      }
    }
  });

  const unsubscribeReconnect = ws.onReconnect(() => void resyncAfterReconnect());

  return () => {
    unsubscribe();
    unsubscribeReconnect();
    ws.disconnect();
  };
}

/**
 * Catch up after the socket came back. Whether the server restarted or only the socket dropped,
 * every push sent while it was down is lost, and the cache trusts pushes (`staleTime: Infinity`),
 * so it all goes stale: TanStack refetches the queries on screen now and the rest when next used.
 * File contents are the exception: an editor with unsaved changes must take new disk content
 * through its state machine, not as a bare refetch, so they are left to the
 * `worktree_files_resynced` the server sends each re-subscribed worktree. The projects and their
 * worktree lists live in stores, so they are fetched again, which also releases worktrees removed
 * meanwhile.
 */
async function resyncAfterReconnect(): Promise<void> {
  void queryClient.invalidateQueries({ predicate: ({ queryKey }) => !isFileContentKey(queryKey) });
  try {
    await useProjectStore.getState().fetchProjects();
    const { refreshProjectWorktrees } = useWorktreeStore.getState();
    await Promise.all(
      useProjectStore.getState().projects.map((p) => refreshProjectWorktrees(projectRef(p))),
    );
  } catch (error: unknown) {
    serverLog.error("Failed to refresh projects after reconnecting", { error });
  }
}
