import { createLspClient } from "./lsp-client";

// gopls: only worktrees with Go files pay the cost.
export default createLspClient({
  route: "ws/go-lsp",
  name: "gopls",
  languageId: ["go", "go.mod", "go.sum", "go.work"],
  // What to run when modules or a Go toolchain are missing is told this way (`go-lsp-manager.ts`).
  showMessages: true,
});
