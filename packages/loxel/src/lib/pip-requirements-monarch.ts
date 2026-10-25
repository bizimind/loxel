import * as monaco from "monaco-editor";

/**
 * Monarch tokenizer for pip requirements files (`requirements*.txt`, `constraints*.txt`).
 * Shiki bundles no requirements grammar, so `pip-requirements` is a custom Monaco language ID.
 * Token names reuse TextMate scopes so the Shiki-derived Monaco theme colors them. Every
 * construct is line-scoped, so each nested state returns to `root` at the next line start.
 */
const PIP_REQUIREMENTS_MONARCH: monaco.languages.IMonarchLanguage = {
  defaultToken: "",
  tokenPostfix: ".pip-requirements",

  markerKeywords: ["and", "or", "in", "not"],

  tokenizer: {
    root: [
      [/^\s*#.*$/, "comment"],
      // Options: short (-r, -c, -e, -i, -f) and long (--index-url, --hash=...), with a value.
      [/^\s*(?:-[a-zA-Z]|--[a-z][\w-]*)=?/, "keyword", "@option"],
      // Bare URLs and local paths are requirements too.
      [/^\s*(?:[a-z][\w+.-]*:\/\/|\.{0,2}\/)[^\s;]*/, "string", "@url"],
      [/^\s*[A-Za-z0-9][\w.-]*/, "entity.name.type", "@requirement"],
      { include: "@common" },
    ],

    option: [[/^/, "", "@popall"], { include: "@common" }, [/\S+/, "string"]],

    requirement: [
      [/^/, "", "@popall"],
      [/\[/, "punctuation.section", "@extras"],
      [/[=]==|==|!=|~=|<=|>=|<|>/, "keyword.operator"],
      [/@/, "keyword.operator", "@url"],
      [/;/, "punctuation.separator", "@marker"],
      [/,/, "punctuation.separator"],
      { include: "@common" },
      [/[\w.*+!-]+/, "constant.numeric"],
    ],

    extras: [
      [/^/, "", "@popall"],
      [/\]/, "punctuation.section", "@pop"],
      [/,/, "punctuation.separator"],
      [/[\w.-]+/, "entity.other.attribute-name"],
    ],

    url: [
      [/^/, "", "@popall"],
      [/;/, "punctuation.separator", "@marker"],
      { include: "@common" },
      // `#` without whitespace before it is a URL fragment (`#egg=`, `#sha256=`), not a comment.
      [/[^\s;]+/, "string"],
    ],

    marker: [
      [/^/, "", "@popall"],
      [/"[^"]*"|'[^']*'/, "string"],
      [/[=]==|==|!=|~=|<=|>=|<|>/, "keyword.operator"],
      [/[a-z_]+/, { cases: { "@markerKeywords": "keyword", "@default": "support.variable" } }],
      { include: "@common" },
    ],

    // Shared by every state: inline comments (pip requires whitespace before `#`), line
    // continuations, `${VAR}` environment references, and per-requirement options.
    common: [
      [/\s+#.*$/, "comment"],
      [/\\$/, "constant.character.escape"],
      [/\$\{\w+\}/, "variable"],
      [/\s--[a-z][\w-]*=?/, "keyword"],
      [/\s+/, ""],
    ],
  },
};

const PIP_REQUIREMENTS_LANG_CONFIG: monaco.languages.LanguageConfiguration = {
  comments: { lineComment: "#" },
  brackets: [["[", "]"]],
  autoClosingPairs: [
    { open: "[", close: "]" },
    { open: '"', close: '"' },
    { open: "'", close: "'" },
  ],
};

export function registerPipRequirementsLanguage(): void {
  monaco.languages.register({ id: "pip-requirements", aliases: ["pip requirements"] });
  monaco.languages.setMonarchTokensProvider("pip-requirements", PIP_REQUIREMENTS_MONARCH);
  monaco.languages.setLanguageConfiguration("pip-requirements", PIP_REQUIREMENTS_LANG_CONFIG);
}
