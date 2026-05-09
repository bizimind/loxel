import * as monaco from "monaco-editor";

/**
 * Minimal Monarch tokenizer for HCL (covers both `terraform` and `dockerbake`
 * language IDs). Semantic tokens from terraform-ls / docker-language-server
 * emit stale-version ranges that Monaco rejects; this Monarch tokenizer gives
 * us stable syntax colors regardless of LSP state.
 */
const HCL_MONARCH: monaco.languages.IMonarchLanguage = {
  defaultToken: "",
  tokenPostfix: ".hcl",

  keywords: [
    "true",
    "false",
    "null",
    "for",
    "in",
    "if",
    "else",
    "endif",
    "endfor",
    "module",
    "resource",
    "data",
    "variable",
    "output",
    "locals",
    "provider",
    "terraform",
    "target",
    "group",
    "function",
  ],

  operators: [
    "=",
    "==",
    "!=",
    "<",
    ">",
    "<=",
    ">=",
    "&&",
    "||",
    "!",
    "+",
    "-",
    "*",
    "/",
    "%",
    "?",
    ":",
    "=>",
  ],

  symbols: /[=><!~?:&|+\-*/^%]+/,
  escapes: /\\(?:[abfnrtv\\"']|x[0-9A-Fa-f]{1,4}|u[0-9A-Fa-f]{4}|U[0-9A-Fa-f]{8})/,

  tokenizer: {
    root: [
      // Heredoc openers — match and jump to heredoc state with the tag.
      [
        /<<-?\s*([A-Za-z_][A-Za-z0-9_]*)/,
        { token: "string.heredoc.delimiter", next: "@heredoc.$1" },
      ],

      // Identifiers / keywords
      [/[a-zA-Z_][\w-]*/, { cases: { "@keywords": "keyword", "@default": "identifier" } }],

      // Block labels (strings immediately after block type) — handled generically below

      // Whitespace & comments
      { include: "@whitespace" },

      // Strings
      [/"/, { token: "string.quote", next: "@string" }],

      // Numbers
      [/\d*\.\d+([eE][-+]?\d+)?/, "number.float"],
      [/0[xX][0-9a-fA-F]+/, "number.hex"],
      [/\d+/, "number"],

      // Delimiters
      [/[{}()[\]]/, "@brackets"],
      [/[,.]/, "delimiter"],

      // Operators
      [/@symbols/, { cases: { "@operators": "operator", "@default": "" } }],
    ],

    string: [
      [/\$\{/, { token: "delimiter.interpolation", next: "@interpolation" }],
      [/[^\\"$]+/, "string"],
      [/@escapes/, "string.escape"],
      [/\\./, "string.escape.invalid"],
      [/"/, { token: "string.quote", next: "@pop" }],
    ],

    interpolation: [
      [/\}/, { token: "delimiter.interpolation", next: "@pop" }],
      { include: "root" },
    ],

    heredoc: [
      [
        /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*$/,
        {
          cases: {
            "$1==$S2": { token: "string.heredoc.delimiter", next: "@pop" },
            "@default": "string.heredoc",
          },
        },
      ],
      [/\$\{/, { token: "delimiter.interpolation", next: "@interpolation" }],
      [/.+/, "string.heredoc"],
    ],

    whitespace: [
      [/[ \t\r\n]+/, ""],
      [/#.*$/, "comment"],
      [/\/\/.*$/, "comment"],
      [/\/\*/, { token: "comment", next: "@comment" }],
    ],

    comment: [
      [/[^/*]+/, "comment"],
      [/\*\//, { token: "comment", next: "@pop" }],
      [/[/*]/, "comment"],
    ],
  },
};

let registered = false;

export function registerHclMonarch(): void {
  if (registered) return;
  registered = true;
  monaco.languages.setMonarchTokensProvider("terraform", HCL_MONARCH);
  monaco.languages.setMonarchTokensProvider("dockerbake", HCL_MONARCH);
  monaco.languages.setLanguageConfiguration("terraform", HCL_LANG_CONFIG);
  monaco.languages.setLanguageConfiguration("dockerbake", HCL_LANG_CONFIG);
}

const HCL_LANG_CONFIG: monaco.languages.LanguageConfiguration = {
  comments: { lineComment: "#", blockComment: ["/*", "*/"] },
  brackets: [
    ["{", "}"],
    ["[", "]"],
    ["(", ")"],
  ],
  autoClosingPairs: [
    { open: "{", close: "}" },
    { open: "[", close: "]" },
    { open: "(", close: ")" },
    { open: '"', close: '"' },
  ],
  surroundingPairs: [
    { open: "{", close: "}" },
    { open: "[", close: "]" },
    { open: "(", close: ")" },
    { open: '"', close: '"' },
  ],
};
