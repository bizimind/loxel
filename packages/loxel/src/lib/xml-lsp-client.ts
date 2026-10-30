import { createLspClient } from "./lsp-client";

// lemminx: only worktrees with .xml files pay the cost.
export default createLspClient({ route: "ws/xml-lsp", name: "XML", languageId: "xml" });
