import { wsClient } from "@/api/client";
import { javaToolchain } from "@/api/java-env-model";
import { useLspStatusStore } from "@/store/lsp-status";
import { useWorktreeStore } from "@/store/worktrees";

import { createLspClient } from "./lsp-client";
import { createToolchainServerRecovery } from "./toolchain-server-recovery";

// Eclipse JDT LS, on the user's JDK.
const javaLspClient = createLspClient({
  route: "ws/java-lsp",
  name: "Java",
  languageId: "java",
  // JDK and dependency sources, which jdtls serves from what is on the disk.
  virtualDocuments: { scheme: "jdt" },
});

wsClient.subscribe(
  createToolchainServerRecovery({
    changedMessage: javaToolchain.changedMessage,
    client: javaLspClient,
    stoppedServer: () => useLspStatusStore.getState().stopped.get("ws/java-lsp"),
    activeWorktree: () => useWorktreeStore.getState().activeWorktreePath,
  }),
);

export default javaLspClient;
