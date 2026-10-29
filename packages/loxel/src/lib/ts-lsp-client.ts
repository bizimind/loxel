import { createLspClient } from "./lsp-client";

export const { connect: connectTsLsp } = createLspClient({
  route: "ws/ts-lsp",
  name: "TypeScript",
  languageId: ["typescript", "javascript", "tsx", "jsx", "json", "jsonc"],
});
