import { createLspClient } from "./lsp-client";

// detekt and ktlint, in projects configured for them (the server starts nothing for other projects).
export default createLspClient({
  route: "ws/kotlin-lint-lsp",
  name: "Kotlin lint",
  languageId: "kotlin",
  // A missing tool or JVM, or a run that failed, is only told this way.
  showMessages: true,
});
