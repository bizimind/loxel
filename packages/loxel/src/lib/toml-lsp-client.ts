import { createWorktreeLspClient } from "./lsp-client";

const { connect: connectTomlLsp, disconnect: disconnectTomlLsp } = createWorktreeLspClient(
  "ws/toml-lsp",
  "toml",
);

export { connectTomlLsp, disconnectTomlLsp };
