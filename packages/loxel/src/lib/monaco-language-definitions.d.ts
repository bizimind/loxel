/**
 * Narrow ambient typings for Monaco's built-in language definitions. The modules are reachable
 * through monaco-editor's `./*` export map but ship without declarations. Only `conf` is declared,
 * for `python-language-config.ts`, `kotlin-language-config.ts`, `c-language-config.ts` and
 * `monaco-languages.ts`. Verified against monaco-editor 0.57.0; the tests of those modules guard
 * against drift on upgrades.
 */
declare module "monaco-editor/languages/definitions/python/python.js" {
  import type { languages } from "monaco-editor";

  export const conf: languages.LanguageConfiguration;
}

declare module "monaco-editor/languages/definitions/kotlin/kotlin.js" {
  import type { languages } from "monaco-editor";

  export const conf: languages.LanguageConfiguration;
}

declare module "monaco-editor/languages/definitions/cpp/cpp.js" {
  import type { languages } from "monaco-editor";

  export const conf: languages.LanguageConfiguration;
}

declare module "monaco-editor/languages/definitions/objective-c/objective-c.js" {
  import type { languages } from "monaco-editor";

  export const conf: languages.LanguageConfiguration;
}

declare module "monaco-editor/languages/definitions/typescript/typescript.js" {
  import type { languages } from "monaco-editor";

  export const conf: languages.LanguageConfiguration;
}

declare module "monaco-editor/languages/definitions/javascript/javascript.js" {
  import type { languages } from "monaco-editor";

  export const conf: languages.LanguageConfiguration;
}

declare module "monaco-editor/languages/definitions/hcl/hcl.js" {
  import type { languages } from "monaco-editor";

  export const conf: languages.LanguageConfiguration;
}
