import { createLspClient } from "./lsp-client";

const { connect: connectMypyLsp, disconnect: disconnectMypyLsp } = createLspClient({
  route: "ws/mypy-lsp",
  name: "mypy",
  languageId: "python",
});

export { connectMypyLsp, disconnectMypyLsp };
