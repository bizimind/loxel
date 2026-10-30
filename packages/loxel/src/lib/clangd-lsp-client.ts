import { createLspClient } from "./lsp-client";

// clangd: only worktrees with C, C++ or Objective-C files pay the cost. It ignores `languageId` and
// takes each file's language from its compile command, so Objective-C++ needs no ID of its own.
export default createLspClient({
  route: "ws/clangd-lsp",
  name: "clangd",
  languageId: ["c", "cpp", "objective-c"],
});
