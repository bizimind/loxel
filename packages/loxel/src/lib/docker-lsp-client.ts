import { createWorktreeLspClient } from "./lsp-client";

const { connect: connectDockerLsp, disconnect: disconnectDockerLsp } = createWorktreeLspClient(
  "ws/docker-lsp",
  ["dockerfile", "dockerbake"],
);

export { connectDockerLsp, disconnectDockerLsp };
