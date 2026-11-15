import { createLspClient } from "./lsp-client";

// golangci-lint, in trusted Go projects configured for it (the server starts nothing for others).
export default createLspClient({
  route: "ws/golangci-lint-lsp",
  name: "golangci-lint",
  languageId: "go",
  // Setup problems (not installed, a config it does not run) are only told this way.
  showMessages: true,
});
