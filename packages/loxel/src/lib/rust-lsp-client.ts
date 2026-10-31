import { createLspClient } from "./lsp-client";

// rust-analyzer: only worktrees with Rust files pay the cost.
export default createLspClient({
  route: "ws/rust-lsp",
  name: "rust-analyzer",
  languageId: "rust",
  // What to run when a toolchain part is missing is told this way (`rust-lsp-manager.ts`).
  showMessages: true,
});
