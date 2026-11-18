import { createLspClient } from "./lsp-client";

// The project's oxlint: lint diagnostics and quick fixes, next to the TypeScript server.
export default createLspClient({
  route: "ws/oxlint-lsp",
  name: "oxlint",
  languageId: ["javascript", "jsx", "typescript", "tsx"],
  // Models of these languages keep the TypeScript server's `loxel:` URIs.
  keepsEditorUris: true,
  showMessages: true,
});
