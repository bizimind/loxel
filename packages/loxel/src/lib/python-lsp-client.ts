import { createWorktreeLspClient } from "./lsp-client";

const { connect: connectPythonLsp, disconnect: disconnectPythonLsp } = createWorktreeLspClient(
  "ws/python-lsp",
  "python",
);

export { connectPythonLsp, disconnectPythonLsp };
