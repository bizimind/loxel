import { createWorktreeLspClient } from "./lsp-client";

const dockerfile = createWorktreeLspClient("ws/docker-lsp", "dockerfile");
const dockerbake = createWorktreeLspClient("ws/docker-lsp", "dockerbake");

export function connectDockerLsp(wtPath: string): void {
  dockerfile.connect(wtPath);
  dockerbake.connect(wtPath);
}

export function disconnectDockerLsp(): void {
  dockerfile.disconnect();
  dockerbake.disconnect();
}
