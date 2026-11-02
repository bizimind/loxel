import { createLspClient } from "./lsp-client";

// The project's ESLint: lint diagnostics and quick fixes, next to the TypeScript server.
export default createLspClient({
  route: "ws/eslint-lsp",
  name: "ESLint",
  languageId: ["javascript", "jsx", "typescript", "tsx"],
  // Models of these languages belong to the TypeScript server's `loxel://HEAD/` URIs.
  keepsEditorUris: true,
  showMessages: true,
});
