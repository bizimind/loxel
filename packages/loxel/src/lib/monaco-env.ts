import { shikiToMonaco } from "@shikijs/monaco";
import * as monaco from "monaco-editor";
// Worker specifiers go through Monaco 0.56's export map (no `esm/vs/` prefix). The aliased
// `monaco-editor/esm/vs/...` form breaks in dev: Vite pre-bundles it without the worker wrapper.
import editorWorker from "monaco-editor/editor/editor.worker.js?worker";
import cssWorker from "monaco-editor/language/css/css.worker.js?worker";
import htmlWorker from "monaco-editor/language/html/html.worker.js?worker";
import jsonWorker from "monaco-editor/language/json/json.worker.js?worker";

import { wsClient } from "@/api/client";
import { deriveProject, useProjectStore } from "@/store/projects";
import { useWorktreeStore } from "@/store/worktrees";

import { connectAstroLsp, disconnectAstroLsp } from "./astro-lsp-client";
import { connectDockerLsp, disconnectDockerLsp } from "./docker-lsp-client";
import { createEditorOpener } from "./editor-opener";
import { getHighlighter } from "./highlighter";
import { isLiveEditorModel } from "./live-editor-model";
import { resumeLanguageServers } from "./lsp-client";
import { registerLoxelLanguages } from "./monaco-languages";
import { enhanceMonacoThemes, registerMonacoThemes } from "./monaco-theme";
import { isWithin } from "./project-file-helpers";
import { registerPythonLanguageConfiguration } from "./python-language-config";
import { connectPythonLsp, disconnectPythonLsp } from "./python-lsp-client";
import { connectRuffLsp, disconnectRuffLsp } from "./ruff-lsp-client";
import { connectTerraformLsp, disconnectTerraformLsp } from "./terraform-lsp-client";
import { connectTomlLsp, disconnectTomlLsp } from "./toml-lsp-client";
import { connectTsLsp } from "./ts-lsp-client";
import { connectXmlLsp, disconnectXmlLsp } from "./xml-lsp-client";
import { connectYamlLsp } from "./yaml-lsp-client";

self.MonacoEnvironment = {
  getWorker(_: unknown, label: string) {
    if (label === "json") return new jsonWorker();
    if (label === "css" || label === "scss" || label === "less") return new cssWorker();
    if (label === "html" || label === "handlebars" || label === "razor") return new htmlWorker();
    // No TS worker — TS/JS language features come from the TypeScript LSP.
    // No YAML worker — we use yaml-language-server via LSP over WebSocket.
    return new editorWorker();
  },
};

// Disable ALL built-in TS/JS language features; the TypeScript LSP provides them.
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

// Languages Monaco doesn't ship (Dockerfile is built in), so model creation, LSP client
// registration and shikiToMonaco's TextMate tokenizers work for them.
registerLoxelLanguages();

// Docstring auto-close and dedent after block-ending statements, on top of Monaco's built-in config.
void registerPythonLanguageConfiguration();

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

// A restarted Loxel server dropped every language-server socket: reconnect the clients now
// instead of waiting out their backoff, and those that gave up meanwhile.
wsClient.onReconnect(resumeLanguageServers);

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
  // Models counted at creation; `isMatch` can change meanwhile (projects load, worktree switch).
  let counted = new WeakSet<monaco.editor.ITextModel>();

  const isMatch = (model: monaco.editor.ITextModel): boolean => {
    if (!opts.languageIds.includes(model.getLanguageId())) return false;
    if (!activeWt) return false;
    if (!isLiveEditorModel(model)) return false;
    if (isWithin(model.uri.path, activeWt)) return true;
    // Files outside every project (the Others section) are served by the active worktree's LSP.
    return !deriveProject(model.uri.path, useProjectStore.getState().projects);
  };

  const countExistingModels = (): number => {
    counted = new WeakSet();
    let n = 0;
    for (const model of monaco.editor.getModels()) {
      if (!isMatch(model)) continue;
      counted.add(model);
      n += 1;
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
    counted.add(model);
    modelCount += 1;
    if (modelCount === 1) syncConnection();
  });

  monaco.editor.onWillDisposeModel((model) => {
    if (!counted.delete(model)) return;
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

// basedpyright: only worktrees with .py/.pyi files pay the cost.
createLazyLspConnector({
  languageIds: ["python"],
  connect: connectPythonLsp,
  disconnect: disconnectPythonLsp,
});

// ruff server: lint diagnostics, quick fixes, fix all and organize imports, next to basedpyright.
createLazyLspConnector({
  languageIds: ["python"],
  connect: connectRuffLsp,
  disconnect: disconnectRuffLsp,
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

// Tombi: schema validation and completion for TOML (Settings > Schemas), plus TOML syntax checks.
createLazyLspConnector({
  languageIds: ["toml"],
  connect: connectTomlLsp,
  disconnect: disconnectTomlLsp,
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

// Go to definition and links that lead to another file open it in an editor tab.
monaco.editor.registerEditorOpener(createEditorOpener());
