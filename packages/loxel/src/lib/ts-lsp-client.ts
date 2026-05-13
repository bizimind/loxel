import { createWorktreeLspClient } from "./lsp-client";

export const { connect: connectTsLsp } = createWorktreeLspClient("ws/ts-lsp", [
  "typescript",
  "javascript",
  "tsx",
  "jsx",
  "json",
  "jsonc",
]);
