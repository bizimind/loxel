import { createLspClient } from "./lsp-client";

const { connect: connectAstroLsp, disconnect: disconnectAstroLsp } = createLspClient({
  route: "ws/astro-lsp",
  name: "Astro",
  languageId: "astro",
});

export { connectAstroLsp, disconnectAstroLsp };
