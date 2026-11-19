import { sameWorktreeRef, type WorktreeRef } from "@/api/worktree-ref";
import type { StoppedLanguageServer } from "@/store/lsp-status";

import { onLoxelEvent } from "./loxel-events";
import type { LspClient } from "./lsp-client";

interface ToolchainServerRecovery {
  /** The message saying the toolchain of a worktree changed. */
  changedMessage: string;
  client: Pick<LspClient, "connect" | "disconnect">;
  stoppedServer: () => StoppedLanguageServer | undefined;
  activeWorktree: () => WorktreeRef | null;
}

/**
 * Bring a language server back when the toolchain of its worktree changes, if it could not start:
 * installing what it was missing takes no restart of Loxel. A server stopped for any other reason
 * stays as it is, above all one another window took over. Only this client is touched. Listens to
 * every server's changes (`loxel-toolchain-changed`, from ws-bridge); returns the unsubscribe.
 */
export function createToolchainServerRecovery({
  changedMessage,
  client,
  stoppedServer,
  activeWorktree,
}: ToolchainServerRecovery): () => void {
  return onLoxelEvent("loxel-toolchain-changed", (changed) => {
    if (changed.changedMessage !== changedMessage) return;
    if (stoppedServer()?.reason !== "start-failed") return;
    const wt = activeWorktree();
    if (wt === null || !sameWorktreeRef(wt, changed.wt)) return;
    client.disconnect();
    client.connect(wt);
  });
}
