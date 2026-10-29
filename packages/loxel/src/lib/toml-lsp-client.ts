import { createLspClient } from "./lsp-client";

const { connect: connectTomlLsp, disconnect: disconnectTomlLsp } = createLspClient({
  route: "ws/toml-lsp",
  name: "TOML",
  languageId: "toml",
});

export { connectTomlLsp, disconnectTomlLsp };
