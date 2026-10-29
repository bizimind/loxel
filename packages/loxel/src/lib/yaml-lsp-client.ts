import { createLspClient } from "./lsp-client";

const yaml = createLspClient({ route: "ws/yaml-lsp", name: "YAML", languageId: "yaml" });

/** Connect to the YAML language server, shared by every worktree. Idempotent. */
export function connectYamlLsp(): void {
  yaml.connect(null);
}
