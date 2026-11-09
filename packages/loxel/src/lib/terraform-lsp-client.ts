import { createLspClient } from "./lsp-client";

// terraform-ls: only worktrees with `.tf`/`.tfvars`/`.hcl` files pay the cost.
export default createLspClient({
  route: "ws/terraform-lsp",
  name: "Terraform",
  languageId: "terraform",
});
