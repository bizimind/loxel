import { wsClient } from "@/api/client";
import { useLspStatusStore } from "@/store/lsp-status";
import { useWorktreeStore } from "@/store/worktrees";

import { createJavaServerRecovery } from "./java-server-recovery";
import { createLspClient } from "./lsp-client";

// Eclipse JDT LS, on the user's JDK.
const javaLspClient = createLspClient({ route: "ws/java-lsp", name: "Java", languageId: "java" });

wsClient.subscribe(
  createJavaServerRecovery({
    client: javaLspClient,
    stoppedServer: () => useLspStatusStore.getState().stopped.get("ws/java-lsp"),
    activeWorktree: () => useWorktreeStore.getState().activeWorktreePath,
  }),
);

export default javaLspClient;
