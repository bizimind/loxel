import type { WsMessage } from "@/api/ws-protocol";
import type { StoppedLanguageServer } from "@/store/lsp-status";

import type { LspClient } from "./lsp-client";

interface ToolchainServerRecovery {
  /** The message saying the toolchain of a worktree changed. */
  changedMessage: string;
  client: Pick<LspClient, "connect" | "disconnect">;
  stoppedServer: () => StoppedLanguageServer | undefined;
  activeWorktree: () => string | null;
}

/**
 * Bring a language server back when the toolchain of its worktree changes, if it could not start:
 * installing what it was missing takes no restart of Loxel. A server stopped for any other reason
 * stays as it is, above all one another window took over. Only this client is touched.
 */
export function createToolchainServerRecovery({
  changedMessage,
  client,
  stoppedServer,
  activeWorktree,
}: ToolchainServerRecovery): (message: WsMessage) => void {
  return (message) => {
    if (message.type !== changedMessage || !("wtPath" in message)) return;
    if (stoppedServer()?.reason !== "start-failed") return;
    const wtPath = activeWorktree();
    if (wtPath === null || wtPath !== message.wtPath) return;
    client.disconnect();
    client.connect(wtPath);
  };
}
