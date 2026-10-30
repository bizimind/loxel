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
 */
export function useWsSubscription(activeWorktreePath: string | null): void {
  const prevWtRef = useRef<string | null>(null);
  useEffect(() => {
    const prev = prevWtRef.current;
    prevWtRef.current = activeWorktreePath;
    if (prev === activeWorktreePath) return;
    if (activeWorktreePath) {
      wsClient.subscribeWorktree(activeWorktreePath);
      // `python_env_changed` and `java_env_changed` reach only subscribers, so a cached interpreter
      // or JDK may have gone stale while this window was on another worktree.
      void queryClient.invalidateQueries({ queryKey: queryKeys.pythonEnvAll() });
      void queryClient.invalidateQueries({ queryKey: queryKeys.javaEnvAll() });
    }
    if (prev) {
      onWorktreeSavesDrained(prev, () => wsClient.unsubscribeWorktree(prev));
    }
  }, [activeWorktreePath]);

  useEffect(() => {
    return wsClient.onReconnect(() => {
      const wt = useWorktreeStore.getState().activeWorktreePath;
      if (wt) {
        wsClient.subscribeWorktree(wt);
        const externalPaths = openEditorPaths(useEditorStateStore.getState().files).filter(
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
