import { javaToolchain } from "@/api/java-env-model";
import type { WsMessage } from "@/api/ws-protocol";
import type { StoppedLanguageServer } from "@/store/lsp-status";

import type { LspClient } from "./lsp-client";

interface JavaServerRecovery {
  client: Pick<LspClient, "connect" | "disconnect">;
  stoppedServer: () => StoppedLanguageServer | undefined;
  activeWorktree: () => string | null;
}

/**
 * Bring the Java server back when the JDKs of its worktree change, if it could not start: installing
 * a JDK it can run on takes no restart of Loxel. A server stopped for any other reason stays as it
 * is, above all one another window took over. Only this client is touched.
 */
export function createJavaServerRecovery({
  client,
  stoppedServer,
  activeWorktree,
}: JavaServerRecovery): (message: WsMessage) => void {
  return (message) => {
    if (message.type !== javaToolchain.changedMessage) return;
    if (stoppedServer()?.reason !== "start-failed") return;
    const wtPath = activeWorktree();
    if (wtPath === null || wtPath !== message.wtPath) return;
    client.disconnect();
    client.connect(wtPath);
  };
}
