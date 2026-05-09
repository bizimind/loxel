import { createWorktreeLspClient } from "./lsp-client";

const { connect: connectTerraformLsp, disconnect: disconnectTerraformLsp } =
  createWorktreeLspClient("ws/terraform-lsp", "terraform");

export { connectTerraformLsp, disconnectTerraformLsp };
