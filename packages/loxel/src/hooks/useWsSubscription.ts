import { useEffect, useRef } from "react";

import { wsClient } from "@/api/client";
import { onWorktreeSavesDrained } from "@/lib/save-editor-content";
import { queryKeys } from "@/queries/query-keys";
import { queryClient } from "@/query-client";
import { openEditorPaths, useEditorStateStore } from "@/store/editor-state";
import { useWorktreeStore } from "@/store/worktrees";

/**
 * Subscribe to worktrees for push events.
 * Switching worktrees subscribes to the new one and defers unsubscribing the
 * old until all pending saves complete (via onWorktreeSavesDrained). This keeps
 * server resources alive so auto-save flushes during panel unmount succeed.
 * `wsClient` subscribes every one of them again after a reconnect.
 */
export function useWsSubscription(activeWorktreePath: string | null): void {
  const prevWtRef = useRef<string | null>(null);
  useEffect(() => {
    const prev = prevWtRef.current;
    prevWtRef.current = activeWorktreePath;
    if (prev === activeWorktreePath) return;
    if (activeWorktreePath) {
      wsClient.subscribeWorktree(activeWorktreePath);
      // A toolchain's changed message reaches only subscribers, so a cached status may have gone
      // stale while this window was on another worktree.
      void queryClient.invalidateQueries({ queryKey: queryKeys.toolchainStatusAll() });
    }
    if (prev) {
      onWorktreeSavesDrained(prev, () => {
        // Switched back before its saves drained: it is the shown worktree again.
        if (prevWtRef.current === prev) return;
        wsClient.unsubscribeWorktree(prev);
      });
    }
  }, [activeWorktreePath]);

  useEffect(() => {
    // The server forgets a socket's open external files with it; tell the new one again.
    return wsClient.onReconnect(() => {
      const wt = useWorktreeStore.getState().activeWorktreePath;
      if (!wt) return;
      const externalPaths = openEditorPaths(useEditorStateStore.getState().files).filter(
        (p) => p.startsWith("/") && !p.startsWith(wt + "/"),
      );
      if (externalPaths.length === 0) return;
      wsClient.send({
        type: "register_external_files",
        worktreePath: wt,
        filePaths: externalPaths,
      });
    });
  }, []);
}
