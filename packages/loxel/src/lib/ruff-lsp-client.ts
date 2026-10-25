import { createWorktreeLspClient } from "./lsp-client";

const { connect: connectRuffLsp, disconnect: disconnectRuffLsp } = createWorktreeLspClient(
  "ws/ruff-lsp",
  "python",
);

export { connectRuffLsp, disconnectRuffLsp };
