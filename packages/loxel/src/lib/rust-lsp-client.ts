import { wsClient } from "@/api/client";
import { rustToolchain } from "@/api/rust-toolchain-model";
import { useLspStatusStore } from "@/store/lsp-status";
import { useWorktreeStore } from "@/store/worktrees";

import { createLspClient } from "./lsp-client";

// rust-analyzer: only worktrees with Rust files pay the cost.
const rustLspClient = createLspClient({
  route: "ws/rust-lsp",
  name: "rust-analyzer",
  languageId: "rust",
  // What to run when a toolchain part is missing is told this way (`rust-lsp-manager.ts`).
  showMessages: true,
});

// A server that could not start comes back with the toolchain it was waiting for.
wsClient.subscribe((message) => {
  if (message.type !== rustToolchain.changedMessage) return;
  if (useLspStatusStore.getState().stopped.get("ws/rust-lsp")?.reason !== "start-failed") return;
  const wtPath = useWorktreeStore.getState().activeWorktreePath;
  if (wtPath === null || wtPath !== message.wtPath) return;
  rustLspClient.disconnect();
  rustLspClient.connect(wtPath);
});

export default rustLspClient;
