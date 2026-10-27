import * as monaco from "monaco-editor";

import { createWorktreeLspClient } from "./lsp-client";
import { reportDocumentIndentation } from "./lsp-document-indentation";

const TS_LANGUAGE_IDS = ["typescript", "javascript", "tsx", "jsx", "json", "jsonc"];

// TypeScript indents the code of its quick fixes and completions by each file's indentation.
export const { connect: connectTsLsp } = createWorktreeLspClient(
  "ws/ts-lsp",
  TS_LANGUAGE_IDS,
  (transport) => reportDocumentIndentation(transport, TS_LANGUAGE_IDS, monaco.editor),
);
