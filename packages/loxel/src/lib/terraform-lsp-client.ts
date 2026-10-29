import { createLspClient } from "./lsp-client";

const { connect: connectTerraformLsp, disconnect: disconnectTerraformLsp } = createLspClient({
  route: "ws/terraform-lsp",
  name: "Terraform",
  languageId: "terraform",
});

export { connectTerraformLsp, disconnectTerraformLsp };
