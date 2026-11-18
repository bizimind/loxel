import type { LspClient } from "./lsp-client";

/**
 * Every language server started lazily: the default export of each `<name>-lsp-client.ts`, so a new
 * server edits no shared file. TypeScript and YAML connect differently and stay explicit in
 * `monaco-env.ts`.
 */
export const lazyLspClients = Object.values(
  import.meta.glob<LspClient>(
    ["./*-lsp-client.ts", "!./ts-lsp-client.ts", "!./yaml-lsp-client.ts"],
    { eager: true, import: "default" },
  ),
);

/**
 * Monaco languages whose editor models use `file:` URIs (see `editorFileUri`): those of the servers
 * above, except a client with `keepsEditorUris`, which need real disk paths (schemas, workspace
 * indexing, import resolution), plus YAML and JSON (schemas). Other languages get `loxel:` URIs,
 * which reach their servers as `loxel://head/<path>` for the TypeScript server bridge to translate.
 */
export const fileSchemeLanguages: ReadonlySet<string> = new Set([
  "json",
  "yaml",
  ...lazyLspClients.flatMap((client) => (client.keepsEditorUris ? [] : client.languageIds)),
]);
