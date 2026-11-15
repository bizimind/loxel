import { createLspClient } from "./lsp-client";

// The project's oxlint: lint diagnostics and quick fixes, next to the TypeScript server.
export default createLspClient({
  route: "ws/oxlint-lsp",
  name: "oxlint",
  languageId: ["javascript", "jsx", "typescript", "tsx"],
  // Models of these languages belong to the TypeScript server's `loxel://HEAD/` URIs.
  keepsEditorUris: true,
  showMessages: true,
});
