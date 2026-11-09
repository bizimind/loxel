import { createLspClient } from "./lsp-client";

// ruff server: lint diagnostics, quick fixes, fix all and organize imports, next to basedpyright.
export default createLspClient({ route: "ws/ruff-lsp", name: "Ruff", languageId: "python" });
