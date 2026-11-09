import { createLspClient } from "./lsp-client";

// docker-language-server: only worktrees with Dockerfile/docker-bake.hcl pay.
export default createLspClient({
  route: "ws/docker-lsp",
  name: "Docker",
  languageId: ["dockerfile", "dockerbake"],
});
