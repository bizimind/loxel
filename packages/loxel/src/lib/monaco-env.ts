import { shikiToMonaco } from "@shikijs/monaco";
import * as monaco from "monaco-editor";
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker.js?worker";
import cssWorker from "monaco-editor/esm/vs/language/css/css.worker.js?worker";
import htmlWorker from "monaco-editor/esm/vs/language/html/html.worker.js?worker";
import jsonWorker from "monaco-editor/esm/vs/language/json/json.worker.js?worker";

import { useWorktreeStore } from "@/store/worktrees";

import { connectAstroLsp, disconnectAstroLsp } from "./astro-lsp-client";
import { connectDockerLsp, disconnectDockerLsp } from "./docker-lsp-client";
import { registerDockerBakeMonarch } from "./hcl-monarch";
import { getHighlighter } from "./highlighter";
import { enhanceMonacoThemes, registerMonacoThemes } from "./monaco-theme";
import { dispatchOpenFile } from "./open-file";
import { connectPythonLsp, disconnectPythonLsp } from "./python-lsp-client";
import { connectTerraformLsp, disconnectTerraformLsp } from "./terraform-lsp-client";
import { connectTsLsp } from "./ts-lsp-client";
import { connectXmlLsp, disconnectXmlLsp } from "./xml-lsp-client";
import { connectYamlLsp } from "./yaml-lsp-client";

self.MonacoEnvironment = {
  getWorker(_: unknown, label: string) {
    if (label === "json") return new jsonWorker();
    if (label === "css" || label === "scss" || label === "less") return new cssWorker();
    if (label === "html" || label === "handlebars" || label === "razor") return new htmlWorker();
    // No TS worker — we use a server-backed HoverProvider instead.
    // No YAML worker — we use yaml-language-server via LSP over WebSocket.
    return new editorWorker();
  },
};

// Disable ALL built-in TS/JS language features. We use server-backed hover and TypeScript diagnostics.
// This prevents Monaco from trying to load the TS worker module (which causes the toUrl error
// since we return the generic editor worker instead of the TS worker).
const disabledModeConfig: monaco.typescript.ModeConfiguration = {
  completionItems: false,
  hovers: false,
  definitions: false,
  references: false,
  documentHighlights: false,
  documentSymbols: false,
  rename: false,
  diagnostics: false,
  documentRangeFormattingEdits: false,
  signatureHelp: false,
  onTypeFormattingEdits: false,
  codeActions: false,
  inlayHints: false,
};
monaco.typescript.typescriptDefaults.setModeConfiguration(disabledModeConfig);
monaco.typescript.javascriptDefaults.setModeConfiguration(disabledModeConfig);

// Register themes before any editor mounts to prevent flicker
registerMonacoThemes();

// Register languages that Monaco doesn't ship out of the box so model
// creation + LSP client registration work. Dockerfile is built in.
monaco.languages.register({
  id: "terraform",
  extensions: [".tf", ".tfvars", ".hcl"],
  aliases: ["Terraform", "HCL", "terraform"],
});

monaco.languages.register({ id: "astro", extensions: [".astro"], aliases: ["Astro", "astro"] });

// TSX/JSX as distinct language IDs so shikiToMonaco can attach TextMate tokenizers.
// Monaco has built-in "typescript"/"javascript" but not "tsx"/"jsx". TS language
// features come from the TypeScript LSP, not Monaco's built-in TS workers (disabled above).
monaco.languages.register({
  id: "tsx",
  extensions: [".tsx"],
  aliases: ["TypeScript React", "tsx"],
});
monaco.languages.register({
  id: "jsx",
  extensions: [".jsx"],
  aliases: ["JavaScript React", "jsx"],
});

// docker-bake HCL — served by docker-language-server, not terraform-ls.
monaco.languages.register({ id: "dockerbake", aliases: ["Docker Bake", "dockerbake"] });

// Monarch tokenizer for docker-bake HCL — not a Shiki-bundled language.
registerDockerBakeMonarch();

// Astro language configuration (brackets, comments, auto-closing pairs).
// shikiToMonaco handles tokenization; this provides editing behavior.
monaco.languages.setLanguageConfiguration("astro", {
  comments: { lineComment: "//", blockComment: ["/*", "*/"] },
  brackets: [
    ["{", "}"],
    ["[", "]"],
    ["(", ")"],
    ["<", ">"],
  ],
  autoClosingPairs: [
    { open: "{", close: "}" },
    { open: "[", close: "]" },
    { open: "(", close: ")" },
    { open: '"', close: '"' },
    { open: "'", close: "'" },
    { open: "`", close: "`" },
    { open: "<!--", close: "-->" },
  ],
  surroundingPairs: [
    { open: "{", close: "}" },
    { open: "[", close: "]" },
    { open: "(", close: ")" },
    { open: '"', close: '"' },
    { open: "'", close: "'" },
    { open: "`", close: "`" },
    { open: "<", close: ">" },
  ],
});

// Bridge Shiki's TextMate grammars into Monaco for VS Code-quality highlighting.
// This replaces Monarch tokenizers for all Shiki-bundled languages (TS, JS, HTML,
// CSS, Astro, Terraform, etc.) with TextMate-based tokenizers. loxel-dark is
// loaded as Shiki themes so shikiToMonaco recognizes them natively.
void getHighlighter().then((highlighter) => {
  shikiToMonaco(highlighter, monaco);
  enhanceMonacoThemes(highlighter);
});

// Connect to yaml-language-server — LSP features register async when capabilities arrive
connectYamlLsp();

// Worktree-scoped LSPs: one subprocess per language per worktree, rooted at
// the worktree path so project-level features (cross-file refs, module
// resolution, relative Dockerfile paths in bake) resolve correctly.
// Reconnect whenever the active worktree changes.
{
  const reconnectPerWorktree = (wtPath: string) => {
    connectTsLsp(wtPath);
  };
  const initialWt = useWorktreeStore.getState().activeWorktreePath;
  if (initialWt) reconnectPerWorktree(initialWt);
  useWorktreeStore.subscribe((state, prev) => {
    if (state.activeWorktreePath && state.activeWorktreePath !== prev.activeWorktreePath) {
      reconnectPerWorktree(state.activeWorktreePath);
    }
  });
}

// Some LSPs are expensive to spawn (they walk the whole workspace) and most
// worktrees have zero files for them. Defer spawning until a matching model
// exists in the active worktree, and disconnect when the last one goes away.
function createLazyLspConnector(opts: {
  languageIds: readonly string[];
  connect: (wtPath: string) => void;
  disconnect: () => void;
}): void {
  let activeWt: string | null = useWorktreeStore.getState().activeWorktreePath ?? null;
  let modelCount = 0;

  const isMatch = (model: monaco.editor.ITextModel): boolean => {
    if (!opts.languageIds.includes(model.getLanguageId())) return false;
    if (!activeWt) return false;
    return model.uri.path.startsWith(activeWt);
  };

  const countExistingModels = (): number => {
    let n = 0;
    for (const model of monaco.editor.getModels()) {
      if (isMatch(model)) n += 1;
    }
    return n;
  };

  const syncConnection = () => {
    if (activeWt && modelCount > 0) {
      opts.connect(activeWt);
    } else {
      opts.disconnect();
    }
  };

  modelCount = countExistingModels();
  syncConnection();

  monaco.editor.onDidCreateModel((model) => {
    if (!isMatch(model)) return;
    modelCount += 1;
    if (modelCount === 1) syncConnection();
  });

  monaco.editor.onWillDisposeModel((model) => {
    if (!isMatch(model)) return;
    modelCount = Math.max(0, modelCount - 1);
    if (modelCount === 0) syncConnection();
  });

  useWorktreeStore.subscribe((state, prev) => {
    if (!state.activeWorktreePath || state.activeWorktreePath === prev.activeWorktreePath) return;
    activeWt = state.activeWorktreePath;
    modelCount = countExistingModels();
    syncConnection();
  });
}

// terraform-ls: only worktrees with `.tf`/`.tfvars`/`.hcl` files pay the cost.
createLazyLspConnector({
  languageIds: ["terraform"],
  connect: connectTerraformLsp,
  disconnect: disconnectTerraformLsp,
});

// docker-language-server: only worktrees with Dockerfile/docker-bake.hcl pay.
createLazyLspConnector({
  languageIds: ["dockerfile", "dockerbake"],
  connect: connectDockerLsp,
  disconnect: disconnectDockerLsp,
});

// pyright: only worktrees with .py/.pyi files pay the cost.
createLazyLspConnector({
  languageIds: ["python"],
  connect: connectPythonLsp,
  disconnect: disconnectPythonLsp,
});

// astro-ls: only worktrees with .astro files pay the cost.
createLazyLspConnector({
  languageIds: ["astro"],
  connect: connectAstroLsp,
  disconnect: disconnectAstroLsp,
});

// lemminx: only worktrees with .xml files pay the cost.
createLazyLspConnector({
  languageIds: ["xml"],
  connect: connectXmlLsp,
  disconnect: disconnectXmlLsp,
});

// Initialize JSON language service — schemas populated dynamically via json-schema-registry.
// Permissive mode: comments/trailing commas are NOT flagged here.
// Strict JSON validation is handled per-file by json-strict-validator.ts.
monaco.json.jsonDefaults.setDiagnosticsOptions({
  validate: true,
  allowComments: true,
  comments: "ignore",
  trailingCommas: "ignore",
  enableSchemaRequest: false,
  schemas: [],
});

// Trigger initial schema sync after settings hydrate from localStorage
import { initSchemaSync } from "./schema-sync";
initSchemaSync();

// TS/JS language features (hover, completions, definition, references,
// semantic tokens, diagnostics) are delivered by the TypeScript LSP over the
// WebSocket at /ws/ts-lsp via packages/monaco-lsp-client. No providers are
// registered here — doing so would compete with the LSP-backed providers.

// Handle cross-file navigation from "go to definition" — opens target in a new editor tab.
monaco.editor.registerEditorOpener({
  openCodeEditor(_source, resource, selectionOrPosition) {
    if (resource.scheme !== "loxel") return false;

    const filePath = resource.path;
    let line = 1;
    let column = 1;

    if (selectionOrPosition) {
      if ("startLineNumber" in selectionOrPosition) {
        line = selectionOrPosition.startLineNumber;
        column = selectionOrPosition.startColumn;
      } else {
        line = selectionOrPosition.lineNumber;
        column = selectionOrPosition.column;
      }
    }

    dispatchOpenFile(filePath, { line, column });
    return true;
  },
});
