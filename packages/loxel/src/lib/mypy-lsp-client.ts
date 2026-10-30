import { createLspClient } from "./lsp-client";

const { connect: connectMypyLsp, disconnect: disconnectMypyLsp } = createLspClient({
  route: "ws/mypy-lsp",
  name: "mypy",
  languageId: "python",
  // Setup problems (mypy not installed, a config error) are only told this way.
  showMessages: true,
});

export { connectMypyLsp, disconnectMypyLsp };
