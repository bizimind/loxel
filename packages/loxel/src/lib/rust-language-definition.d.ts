/**
 * Narrow ambient typing for Monaco's built-in Rust definition, as in
 * `monaco-language-definitions.d.ts`. Verified against monaco-editor 0.57.0;
 * `rust-language-config.test.ts` guards against drift on upgrades.
 */
declare module "monaco-editor/languages/definitions/rust/rust.js" {
  import type { languages } from "monaco-editor";

  export const conf: languages.LanguageConfiguration;
}
