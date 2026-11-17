import { createLspClient } from "./lsp-client";

// dockerfile-language-server-nodejs: only worktrees with a Dockerfile open pay.
export default createLspClient({
  route: "ws/docker-lsp",
  name: "Docker",
  languageId: "dockerfile",
});
