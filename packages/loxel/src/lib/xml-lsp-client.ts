import { createWorktreeLspClient } from "./lsp-client";

const { connect: connectXmlLsp, disconnect: disconnectXmlLsp } = createWorktreeLspClient(
  "ws/xml-lsp",
  "xml",
);

export { connectXmlLsp, disconnectXmlLsp };
