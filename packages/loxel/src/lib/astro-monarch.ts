import * as monaco from "monaco-editor";

/**
 * Monarch tokenizer for Astro (.astro) files. Handles the two-section
 * structure: TypeScript frontmatter between `---` fences and an
 * HTML-like template below. Semantic tokens from the Astro LSP layer
 * on top for richer highlighting (variables, types, etc.).
 */
const ASTRO_MONARCH: monaco.languages.IMonarchLanguage = {
  defaultToken: "",

  keywords: [
    "break",
    "case",
    "catch",
    "class",
    "const",
    "continue",
    "default",
    "delete",
    "do",
    "else",
    "enum",
    "export",
    "extends",
    "false",
    "finally",
    "for",
    "from",
    "function",
    "if",
    "implements",
    "import",
    "in",
    "instanceof",
    "interface",
    "let",
    "new",
    "null",
    "of",
    "private",
    "protected",
    "public",
    "readonly",
    "return",
    "static",
    "super",
    "switch",
    "this",
    "throw",
    "true",
    "try",
    "type",
    "typeof",
    "undefined",
    "var",
    "void",
    "while",
    "yield",
    "async",
    "await",
    "as",
  ],

  typeKeywords: ["string", "number", "boolean", "any", "unknown", "never", "object", "symbol"],

  operators: [
    "=",
    "==",
    "===",
    "!=",
    "!==",
    "<",
    ">",
    "<=",
    ">=",
    "&&",
    "||",
    "??",
    "!",
    "+",
    "-",
    "*",
    "/",
    "%",
    "**",
    "?",
    ":",
    "=>",
    "...",
    "?.",
  ],

  symbols: /[=><!~?:&|+\-*/^%]+/,
  escapes: /\\(?:[abfnrtv\\"'`]|x[0-9A-Fa-f]{2}|u[0-9A-Fa-f]{4}|u\{[0-9A-Fa-f]+\})/,

  tokenizer: {
    root: [
      // Opening frontmatter fence — must be the first non-whitespace
      [/^---\s*$/, { token: "keyword.frontmatter", next: "@frontmatter" }],
      // Everything outside frontmatter is HTML template
      { include: "@template" },
    ],

    // --- TypeScript frontmatter ---
    frontmatter: [
      [/^---\s*$/, { token: "keyword.frontmatter", next: "@template" }],
      { include: "@tsCommon" },
    ],

    tsCommon: [
      [/[ \t\r\n]+/, ""],
      [/\/\/.*$/, "comment"],
      [/\/\*/, { token: "comment", next: "@tsBlockComment" }],
      [
        /[a-zA-Z_$][\w$]*/,
        { cases: { "@keywords": "keyword", "@typeKeywords": "type", "@default": "identifier" } },
      ],
      [/\d*\.\d+([eE][-+]?\d+)?/, "number.float"],
      [/0[xX][0-9a-fA-F]+/, "number.hex"],
      [/\d+/, "number"],
      [/"/, { token: "string.quote", next: "@tsDoubleString" }],
      [/'/, { token: "string.quote", next: "@tsSingleString" }],
      [/`/, { token: "string.quote", next: "@tsTemplateString" }],
      [/[{}()[\]]/, "@brackets"],
      [/[,;.]/, "delimiter"],
      [/@symbols/, { cases: { "@operators": "operator", "@default": "" } }],
    ],

    tsDoubleString: [
      [/[^\\"]+/, "string"],
      [/@escapes/, "string.escape"],
      [/\\./, "string.escape.invalid"],
      [/"/, { token: "string.quote", next: "@pop" }],
    ],

    tsSingleString: [
      [/[^\\']+/, "string"],
      [/@escapes/, "string.escape"],
      [/\\./, "string.escape.invalid"],
      [/'/, { token: "string.quote", next: "@pop" }],
    ],

    tsTemplateString: [
      [/\$\{/, { token: "delimiter.interpolation", next: "@tsInterpolation" }],
      [/[^`$\\]+/, "string"],
      [/@escapes/, "string.escape"],
      [/\\./, "string.escape.invalid"],
      [/`/, { token: "string.quote", next: "@pop" }],
    ],

    tsInterpolation: [
      [/\}/, { token: "delimiter.interpolation", next: "@pop" }],
      { include: "@tsCommon" },
    ],

    tsBlockComment: [
      [/[^/*]+/, "comment"],
      [/\*\//, { token: "comment", next: "@pop" }],
      [/[/*]/, "comment"],
    ],

    // --- HTML template ---
    template: [
      [/\{/, { token: "delimiter.interpolation", next: "@expression" }],
      [/<!--/, { token: "comment", next: "@htmlComment" }],
      [/<style[\s>]/, { token: "tag", next: "@styleTag" }],
      [/<script[\s>]/, { token: "tag", next: "@scriptTag" }],
      [
        /(<)(\/?)([a-zA-Z][\w.:$-]*)/,
        ["delimiter.html", "delimiter.html", { token: "tag", next: "@htmlTag" }],
      ],
      [/[^<{]+/, ""],
    ],

    expression: [
      [/\{/, { token: "delimiter.interpolation", next: "@expression" }],
      [/\}/, { token: "delimiter.interpolation", next: "@pop" }],
      // HTML tags before tsCommon so `<` isn't consumed by the @symbols operator regex
      [
        /(<)(\/?)([a-zA-Z][\w.:$-]*)/,
        ["delimiter.html", "delimiter.html", { token: "tag", next: "@htmlTag" }],
      ],
      { include: "@tsCommon" },
    ],

    htmlComment: [
      [/-->/, { token: "comment", next: "@pop" }],
      [/.+?(?=-->|$)/, "comment"],
    ],

    htmlTag: [
      [/\{/, { token: "delimiter.interpolation", next: "@expression" }],
      [/[a-zA-Z][\w-]*(?=\s*=)/, "attribute.name"],
      [/[=]/, "delimiter"],
      [/"[^"]*"/, "attribute.value"],
      [/'[^']*'/, "attribute.value"],
      [/\/?>/, { token: "delimiter.html", next: "@pop" }],
      [/[ \t\r\n]+/, ""],
      [/[a-zA-Z][\w-]*/, "attribute.name"],
    ],

    styleTag: [
      [/<\/style\s*>/, { token: "tag", next: "@pop" }],
      // Inline CSS: match properties and values loosely
      [/.+?(?=<\/style|$)/, "string"],
    ],

    scriptTag: [[/<\/script\s*>/, { token: "tag", next: "@pop" }], { include: "@tsCommon" }],
  },
};

const ASTRO_LANG_CONFIG: monaco.languages.LanguageConfiguration = {
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
  folding: { markers: { start: /^\s*---\s*$/, end: /^\s*---\s*$/ } },
};

let registered = false;

export function registerAstroMonarch(): void {
  if (registered) return;
  registered = true;
  monaco.languages.setMonarchTokensProvider("astro", ASTRO_MONARCH);
  monaco.languages.setLanguageConfiguration("astro", ASTRO_LANG_CONFIG);
}
