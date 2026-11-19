import { javaToolchain } from "@/api/java-env-model";
import { getQueryScope } from "@/queries/use-scope";
import { useLspStatusStore } from "@/store/lsp-status";

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

createToolchainServerRecovery({
  changedMessage: javaToolchain.changedMessage,
  client: javaLspClient,
  stoppedServer: () => useLspStatusStore.getState().stopped.get("ws/java-lsp"),
  activeWorktree: () => getQueryScope().activeWorktree,
});

export default javaLspClient;
