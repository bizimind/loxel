/**
 * Narrow ambient typings for Monaco's built-in C# and Razor definitions, for
 * `csharp-language-config.ts`, like `monaco-language-definitions.d.ts`. Verified against
 * monaco-editor 0.57.0; `csharp-language-config.test.ts` guards against drift on upgrades.
 */
declare module "monaco-editor/languages/definitions/csharp/csharp.js" {
  import type { languages } from "monaco-editor";

  export const conf: languages.LanguageConfiguration;
}

declare module "monaco-editor/languages/definitions/razor/razor.js" {
  import type { languages } from "monaco-editor";

  export const conf: languages.LanguageConfiguration;
}
