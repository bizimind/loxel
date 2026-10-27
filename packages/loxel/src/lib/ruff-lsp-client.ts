import { createLspClient } from "./lsp-client";

const { connect: connectRuffLsp, disconnect: disconnectRuffLsp } = createLspClient({
  route: "ws/ruff-lsp",
  name: "Ruff",
  languageId: "python",
});

export { connectRuffLsp, disconnectRuffLsp };
