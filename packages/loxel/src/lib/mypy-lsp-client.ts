import { createLspClient } from "./lsp-client";

// mypy, in projects configured for it: type checking in place of basedpyright's (the server starts
// nothing for other projects).
export default createLspClient({
  route: "ws/mypy-lsp",
  name: "mypy",
  languageId: "python",
  // Setup problems (mypy not installed, a config error) are only told this way.
  showMessages: true,
});
