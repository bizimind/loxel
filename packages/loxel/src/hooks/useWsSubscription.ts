import { useEffect, useRef } from "react";

import { wsClient } from "@/api/client";
import { onWorktreeSavesDrained } from "@/lib/save-editor-content";
import { useEditorStateStore } from "@/store/editor-state";
import { useWorktreeStore } from "@/store/worktrees";

/**
 * Subscribe to worktrees for push events.
 * Switching worktrees subscribes to the new one and defers unsubscribing the
 * old until all pending saves complete (via onWorktreeSavesDrained). This keeps
 * server resources alive so auto-save flushes during panel unmount succeed.
 */
export function useWsSubscription(activeWorktreePath: string | null): void {
  const prevWtRef = useRef<string | null>(null);
  useEffect(() => {
    const prev = prevWtRef.current;
    prevWtRef.current = activeWorktreePath;
    if (prev === activeWorktreePath) return;
    if (activeWorktreePath) wsClient.subscribeWorktree(activeWorktreePath);
    if (prev) {
      onWorktreeSavesDrained(prev, () => wsClient.unsubscribeWorktree(prev));
    }
  }, [activeWorktreePath]);

  useEffect(() => {
    return wsClient.onReconnect(() => {
      const wt = useWorktreeStore.getState().activeWorktreePath;
      if (wt) {
        wsClient.subscribeWorktree(wt);
        const externalPaths = [...useEditorStateStore.getState().files.keys()].filter(
          (p) => p.startsWith("/") && !p.startsWith(wt + "/"),
        );
        if (externalPaths.length > 0) {
          wsClient.send({
            type: "register_external_files",
            worktreePath: wt,
            filePaths: externalPaths,
          });
        }
      }
    });
  }, []);
}
