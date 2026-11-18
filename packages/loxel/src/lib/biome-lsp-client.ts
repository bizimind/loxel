import { createLspClient } from "./lsp-client";

// The project's Biome: lint diagnostics and quick fixes, next to the TypeScript server.
export default createLspClient({
  route: "ws/biome-lsp",
  name: "Biome",
  languageId: ["javascript", "jsx", "typescript", "tsx"],
  // Models of these languages keep the TypeScript server's `loxel:` URIs.
  keepsEditorUris: true,
  showMessages: true,
});
