import { createLspClient } from "./lsp-client";

const { connect: connectDockerLsp, disconnect: disconnectDockerLsp } = createLspClient({
  route: "ws/docker-lsp",
  name: "Docker",
  languageId: ["dockerfile", "dockerbake"],
});

export { connectDockerLsp, disconnectDockerLsp };
