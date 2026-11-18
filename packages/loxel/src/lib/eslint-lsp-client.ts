import { createLspClient } from "./lsp-client";

// The project's ESLint: lint diagnostics and quick fixes, next to the TypeScript server.
export default createLspClient({
  route: "ws/eslint-lsp",
  name: "ESLint",
  languageId: ["javascript", "jsx", "typescript", "tsx"],
  // Models of these languages keep the TypeScript server's `loxel:` URIs.
  keepsEditorUris: true,
  showMessages: true,
});
