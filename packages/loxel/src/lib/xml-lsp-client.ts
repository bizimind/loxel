import { createLspClient } from "./lsp-client";

const { connect: connectXmlLsp, disconnect: disconnectXmlLsp } = createLspClient({
  route: "ws/xml-lsp",
  name: "XML",
  languageId: "xml",
});

export { connectXmlLsp, disconnectXmlLsp };
