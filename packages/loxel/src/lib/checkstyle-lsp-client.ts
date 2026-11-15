import { createLspClient } from "./lsp-client";

// Checkstyle, in projects whose build runs it (the server starts nothing for other projects).
export default createLspClient({
  route: "ws/checkstyle-lsp",
  name: "Checkstyle",
  languageId: "java",
  // Setup problems (Checkstyle not installed, a config that doesn't load) are only told this way.
  showMessages: true,
});
