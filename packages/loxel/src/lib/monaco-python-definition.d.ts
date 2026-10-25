/**
 * Narrow ambient typing for Monaco's built-in Python language definition. The module is reachable
 * through monaco-editor's `./*` export map but ships without declarations. Only `conf` is declared,
 * for `python-language-config.ts`. Verified against monaco-editor 0.57.0;
 * `python-language-config.test.ts` guards against drift on upgrades.
 */
declare module "monaco-editor/languages/definitions/python/python.js" {
  import type { languages } from "monaco-editor";

  export const conf: languages.LanguageConfiguration;
}
