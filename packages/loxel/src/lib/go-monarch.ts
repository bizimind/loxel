import * as monaco from "monaco-editor";

/**
 * Monarch tokenizers for Go's project files. Shiki bundles no grammar for them, so `go.mod`,
 * `go.work` and `go.sum` (the LSP language IDs gopls documents) are custom Monaco language IDs.
 * `go.mod` and `go.work` share one syntax. Token names reuse TextMate scopes so the Shiki-derived
 * Monaco theme colors them.
 */
const GO_MOD_MONARCH: monaco.languages.IMonarchLanguage = {
  defaultToken: "",
  tokenPostfix: ".gomod",

  tokenizer: {
    root: [
      // A directive is the first word of a line outside a block, where a path can't be mistaken
      // for it.
      [
        /^\s*(?:module|go|toolchain|godebug|require|replace|exclude|retract|tool|use|ignore)(?=[\s(]|\/\/|$)/,
        "keyword",
      ],
      [/\(/, "punctuation.section", "@block"],
      { include: "@arguments" },
    ],

    block: [[/\)/, "punctuation.section", "@pop"], { include: "@arguments" }],

    arguments: [
      [/\s+/, ""],
      // Includes `// indirect`. A comment starts at `//` even in the middle of a word.
      [/\/\/.*$/, "comment"],
      [/[=]>/, "keyword.operator"],
      [/"(?:[^"\\]|\\.)*"?|`[^`]*`?/, "string"],
      [/[[\]]/, "punctuation.section"],
      [/,/, "punctuation.separator"],
      // Module versions (`v1.2.3-pre+meta`) and Go versions (`1.23rc1`, `go1.23.0-custom`), whole
      // words only, so paths such as `v2ray.com/core` and `1password.com/sdk` stay paths.
      [
        /(?:v\d+(?:\.\d+){0,2}(?:[-+][-+.\w]*)?|(?:go)?\d+(?:\.\d+)*(?:(?:rc|beta)\d+)?(?:-[-+.\w]*)?)(?=[\s,\])]|\/\/|$)/,
        "constant.numeric",
      ],
      // godebug settings.
      [/([\w.-]+)(=)(?!>)((?:(?!\/\/)\S)*)/, ["variable", "keyword.operator", "string"]],
      // Local paths: `use ./tools`, `replace a => ../a`.
      [/\.{1,2}(?=[\s)]|\/\/|$)|\.{0,2}\/(?:(?!\/\/|=>)[^\s"`()[\],])*/, "string"],
      [/(?:(?!\/\/|=>)[^\s"`()[\],])+/, "entity.name.type"],
    ],
  },
};

/**
 * `<module> <version>[/go.mod] <hash>` on every line. The module comes first, so a module named
 * `v2ray.com/core` isn't a version.
 */
const GO_SUM_MONARCH: monaco.languages.IMonarchLanguage = {
  defaultToken: "",
  tokenPostfix: ".gosum",

  tokenizer: {
    root: [
      [/^\s*\S+/, "entity.name.type"],
      [/v\d\S*/, "constant.numeric"],
      [/h\d+:\S*/, "string"],
      [/\s+/, ""],
    ],
  },
};

const GO_MOD_LANG_CONFIG: monaco.languages.LanguageConfiguration = {
  comments: { lineComment: "//" },
  brackets: [
    ["(", ")"],
    ["[", "]"],
  ],
  autoClosingPairs: [
    { open: "(", close: ")" },
    { open: "[", close: "]" },
    { open: '"', close: '"', notIn: ["string", "comment"] },
    { open: "`", close: "`", notIn: ["string", "comment"] },
  ],
  surroundingPairs: [
    { open: "(", close: ")" },
    { open: "[", close: "]" },
    { open: '"', close: '"' },
    { open: "`", close: "`" },
  ],
};

export function registerGoProjectFileLanguages(): void {
  for (const [id, alias] of [
    ["go.mod", "Go Module"],
    ["go.work", "Go Workspace"],
  ] as const) {
    monaco.languages.register({ id, aliases: [alias] });
    monaco.languages.setMonarchTokensProvider(id, GO_MOD_MONARCH);
    monaco.languages.setLanguageConfiguration(id, GO_MOD_LANG_CONFIG);
  }
  // No configuration: go.sum has no comments or brackets, and a commented line breaks the go command.
  monaco.languages.register({ id: "go.sum", aliases: ["Go Checksums"] });
  monaco.languages.setMonarchTokensProvider("go.sum", GO_SUM_MONARCH);
}
