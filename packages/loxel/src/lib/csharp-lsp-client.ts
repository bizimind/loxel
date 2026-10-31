import { createLspClient } from "./lsp-client";

export default createLspClient({
  route: "ws/csharp-lsp",
  name: "csharp-ls",
  languageId: "csharp",
  // What to install or run while no server runs, and projects that fail to load.
  showMessages: true,
});
