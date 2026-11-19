import { useEffect, useRef } from "react";

import { sendTo, wsClientOf } from "@/api/client";
import { hasConnection } from "@/api/server-connection";
import { type WorktreeRef, sameWorktreeRef, sameOptionalWorktreeRef } from "@/api/worktree-ref";
import { onLoxelEvent } from "@/lib/loxel-events";
import { onWorktreeSavesDrained } from "@/lib/save-editor-content";
import { queryKeys } from "@/queries/query-keys";
import { queryClient } from "@/query-client";
import { openEditorPaths, useEditorStateStore } from "@/store/editor-state";
import { useWorktreeStore } from "@/store/worktrees";

/**
 * Subscribe to worktrees for push events, on the server that holds each.
 * Switching worktrees subscribes to the new one and defers unsubscribing the
 * old until its saves complete, in flight or waiting in the save outbox (via
 * onWorktreeSavesDrained). This keeps server resources alive so auto-save flushes
 * during panel unmount succeed, and queued saves are served when retried.
 * The connection subscribes every one of them again after a reconnect.
 */
export function useWsSubscription(activeWorktree: WorktreeRef | null): void {
  const prevWtRef = useRef<WorktreeRef | null>(null);
  useEffect(() => {
    const prev = prevWtRef.current;
    prevWtRef.current = activeWorktree;
    if (sameOptionalWorktreeRef(prev, activeWorktree)) return;
    // A worktree of a server the window has no connection to (a session restored after the server's
    // id changed) is subscribed nowhere: the project list moves the window off it.
    if (activeWorktree && hasConnection(activeWorktree.server)) {
      wsClientOf(activeWorktree.server).subscribeWorktree(activeWorktree);
      // A toolchain's changed message reaches only subscribers, so a cached status may have gone
      // stale while this window was on another worktree.
      void queryClient.invalidateQueries({ queryKey: queryKeys.toolchainStatusAll() });
    }
    if (prev && hasConnection(prev.server)) {
      onWorktreeSavesDrained(prev, () => {
        // Switched back before its saves drained: it is the shown worktree again.
        if (sameOptionalWorktreeRef(prevWtRef.current, prev)) return;
        // A server the window lost its connection to holds no subscription of it.
        if (hasConnection(prev.server)) wsClientOf(prev.server).unsubscribeWorktree(prev);
      });
    }
  }, [activeWorktree]);

  useEffect(() => {
    // The server forgets a worktree's open external files with its resources (after a reconnect,
    // say), so tell it again once it confirms the subscription: sent right after the subscribe, the
    // list would arrive before the resources exist and be dropped.
    return onLoxelEvent("loxel-worktree-files-resynced", ({ wt: resynced }) => {
      const wt = useWorktreeStore.getState().activeWorktree;
      if (!wt || !sameWorktreeRef(resynced, wt)) return;
      const externalPaths = openEditorPaths(useEditorStateStore.getState().files, wt.server).filter(
        (p) => p.startsWith("/") && !p.startsWith(wt.path + "/"),
      );
      if (externalPaths.length === 0) return;
      sendTo(wt.server, {
        type: "register_external_files",
        worktreePath: wt.path,
        filePaths: externalPaths,
      });
    });
  }, []);
}
