import { wsClient } from "@/api/client";
import { useLspStatusStore } from "@/store/lsp-status";
import { useWorktreeStore } from "@/store/worktrees";

import { createJavaServerRecovery } from "./java-server-recovery";
import { createLspClient } from "./lsp-client";

const ROUTE = "ws/java-lsp";

// Eclipse JDT LS, on the user's JDK.
const javaLspClient = createLspClient({ route: ROUTE, name: "Java", languageId: "java" });

wsClient.subscribe(
  createJavaServerRecovery({
    client: javaLspClient,
    stoppedServer: () => useLspStatusStore.getState().stopped.get(ROUTE),
    activeWorktree: () => useWorktreeStore.getState().activeWorktreePath,
  }),
);

export default javaLspClient;
