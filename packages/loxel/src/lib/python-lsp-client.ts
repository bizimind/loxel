import { createLspClient } from "./lsp-client";

const { connect: connectPythonLsp, disconnect: disconnectPythonLsp } = createLspClient({
  route: "ws/python-lsp",
  name: "basedpyright",
  languageId: "python",
});

export { connectPythonLsp, disconnectPythonLsp };
