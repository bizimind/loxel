import { createLspClient } from "./lsp-client";

// basedpyright: only worktrees with .py/.pyi files pay the cost.
export default createLspClient({
  route: "ws/python-lsp",
  name: "basedpyright",
  languageId: "python",
});
