import { createLspClient } from "./lsp-client";

// Tombi: schema validation and completion for TOML (Settings > Schemas), plus TOML syntax checks.
export default createLspClient({ route: "ws/toml-lsp", name: "TOML", languageId: "toml" });
