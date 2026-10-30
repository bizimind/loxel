import { createLspClient } from "./lsp-client";

// Eclipse JDT LS, on its bundled Java runtime.
export default createLspClient({ route: "ws/java-lsp", name: "Java", languageId: "java" });
