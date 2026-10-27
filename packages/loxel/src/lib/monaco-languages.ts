import * as monaco from "monaco-editor";
import { conf as hclConf } from "monaco-editor/languages/definitions/hcl/hcl.js";
import { conf as javascriptConf } from "monaco-editor/languages/definitions/javascript/javascript.js";
import { conf as typescriptConf } from "monaco-editor/languages/definitions/typescript/typescript.js";

import { registerDockerBakeMonarch } from "./hcl-monarch";
import { registerPipRequirementsLanguage } from "./pip-requirements-monarch";

const TOML_CONFIGURATION: monaco.languages.LanguageConfiguration = {
  comments: { lineComment: "#" },
  brackets: [
    ["{", "}"],
    ["[", "]"],
  ],
  autoClosingPairs: [
    { open: "{", close: "}" },
    { open: "[", close: "]" },
    { open: '"""', close: '"""', notIn: ["comment"] },
    { open: "'''", close: "'''", notIn: ["comment"] },
    { open: '"', close: '"', notIn: ["string"] },
    { open: "'", close: "'", notIn: ["string", "comment"] },
  ],
  surroundingPairs: [
    { open: "{", close: "}" },
    { open: "[", close: "]" },
    { open: '"', close: '"' },
    { open: "'", close: "'" },
  ],
};

const ASTRO_CONFIGURATION: monaco.languages.LanguageConfiguration = {
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
};

/** Shared by make (`$(VAR)`, `${VAR}`) and just (`{{expr}}`, `[attribute]`, `(dependency args)`). */
const HASH_COMMENT_SCRIPT_CONFIGURATION: monaco.languages.LanguageConfiguration = {
  comments: { lineComment: "#" },
  brackets: [
    ["{", "}"],
    ["[", "]"],
    ["(", ")"],
  ],
  autoClosingPairs: [
    { open: "{", close: "}" },
    { open: "[", close: "]" },
    { open: "(", close: ")" },
    { open: '"', close: '"', notIn: ["string"] },
    { open: "'", close: "'", notIn: ["string", "comment"] },
    { open: "`", close: "`", notIn: ["string", "comment"] },
  ],
  surroundingPairs: [
    { open: "{", close: "}" },
    { open: "[", close: "]" },
    { open: "(", close: ")" },
    { open: '"', close: '"' },
    { open: "'", close: "'" },
    { open: "`", close: "`" },
  ],
};

/**
 * Languages Monaco doesn't ship, with their editing behavior (comments, brackets, auto-closing and
 * surrounding pairs, on-enter rules). Most exist as their own IDs so `shikiToMonaco` can attach
 * Shiki's TextMate grammar, which only sets a tokenizer. Where Monaco has a built-in configuration
 * for the same syntax under another ID, it is reused.
 */
const LOXEL_LANGUAGES: {
  language: monaco.languages.ILanguageExtensionPoint;
  configuration: monaco.languages.LanguageConfiguration;
}[] = [
  {
    language: { id: "tsx", extensions: [".tsx"], aliases: ["TypeScript React", "tsx"] },
    configuration: typescriptConf,
  },
  {
    language: { id: "jsx", extensions: [".jsx"], aliases: ["JavaScript React", "jsx"] },
    configuration: javascriptConf,
  },
  {
    language: {
      id: "terraform",
      extensions: [".tf", ".tfvars", ".hcl"],
      aliases: ["Terraform", "HCL", "terraform"],
    },
    configuration: hclConf,
  },
  // docker-bake HCL, served by docker-language-server rather than terraform-ls.
  {
    language: { id: "dockerbake", aliases: ["Docker Bake", "dockerbake"] },
    configuration: hclConf,
  },
  {
    language: { id: "astro", extensions: [".astro"], aliases: ["Astro", "astro"] },
    configuration: ASTRO_CONFIGURATION,
  },
  {
    language: { id: "toml", extensions: [".toml"], aliases: ["TOML", "toml"] },
    configuration: TOML_CONFIGURATION,
  },
  {
    language: { id: "make", extensions: [".mk"], aliases: ["Makefile", "make"] },
    configuration: HASH_COMMENT_SCRIPT_CONFIGURATION,
  },
  {
    language: { id: "just", extensions: [".just"], aliases: ["Just", "just"] },
    configuration: HASH_COMMENT_SCRIPT_CONFIGURATION,
  },
];

/** Register every language Loxel adds to Monaco, before any model is created. */
export function registerLoxelLanguages(): void {
  for (const { language, configuration } of LOXEL_LANGUAGES) {
    monaco.languages.register(language);
    monaco.languages.setLanguageConfiguration(language.id, configuration);
  }
  // Shiki has no grammar for docker-bake or pip requirements, so they get Monarch tokenizers.
  registerDockerBakeMonarch();
  registerPipRequirementsLanguage();
}
