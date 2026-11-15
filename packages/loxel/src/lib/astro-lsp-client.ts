import { createLspClient } from "./lsp-client";

// astro-ls: only worktrees with .astro files pay the cost.
export default createLspClient({ route: "ws/astro-lsp", name: "Astro", languageId: "astro" });
