import * as monaco from "monaco-editor";

import { createLspClient } from "./lsp-client";
import { reportDocumentIndentation } from "./lsp-document-indentation";

const TS_LANGUAGE_IDS = ["typescript", "javascript", "tsx", "jsx", "json", "jsonc"];

export const { connect: connectTsLsp } = createLspClient({
  route: "ws/ts-lsp",
  name: "TypeScript",
  languageId: TS_LANGUAGE_IDS,
  // TypeScript indents the code of its quick fixes and completions by each file's indentation.
  onConnected: (transport) => reportDocumentIndentation(transport, TS_LANGUAGE_IDS, monaco.editor),
});
