import { createWorktreeLspClient } from "./lsp-client";

const { connect: connectAstroLsp, disconnect: disconnectAstroLsp } = createWorktreeLspClient(
  "ws/astro-lsp",
  "astro",
);

export { connectAstroLsp, disconnectAstroLsp };
