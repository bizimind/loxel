import { createLspClient } from "./lsp-client";

// clangd: only worktrees with C, C++ or Objective-C files pay the cost.
export default createLspClient({
  route: "ws/clangd-lsp",
  name: "clangd",
  languageId: ["c", "cpp", "objective-c", "objective-cpp"],
});
