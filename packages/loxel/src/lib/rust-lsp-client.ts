import { wsClient } from "@/api/client";
import { rustToolchain } from "@/api/rust-toolchain-model";
import { useLspStatusStore } from "@/store/lsp-status";
import { useWorktreeStore } from "@/store/worktrees";

import { createLspClient } from "./lsp-client";
import { createToolchainServerRecovery } from "./toolchain-server-recovery";

// rust-analyzer: only worktrees with Rust files pay the cost.
const rustLspClient = createLspClient({
  route: "ws/rust-lsp",
  name: "rust-analyzer",
  languageId: "rust",
  // What to run when a toolchain part is missing is told this way (`rust-lsp-manager.ts`).
  showMessages: true,
});

wsClient.subscribe(
  createToolchainServerRecovery({
    changedMessage: rustToolchain.changedMessage,
    client: rustLspClient,
    stoppedServer: () => useLspStatusStore.getState().stopped.get("ws/rust-lsp"),
    activeWorktree: () => useWorktreeStore.getState().activeWorktreePath,
  }),
);

export default rustLspClient;
