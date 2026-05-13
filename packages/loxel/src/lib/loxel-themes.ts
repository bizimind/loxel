import type { ThemeRegistrationRaw } from "shiki";

export const loxelDark: ThemeRegistrationRaw = {
  name: "loxel-dark",
  type: "dark",
  semanticHighlighting: true,
  colors: {
    "editor.foreground": "#BCBEC4",
    "editor.selectionBackground": "#264f78",
    "editorCursor.foreground": "#BCBEC4",
    "editorIndentGuide.background": "#404040",
    "editorIndentGuide.activeBackground": "#707070",
    "editorBracketMatch.background": "#0064001a",
    "editorBracketMatch.border": "#888888",
    "editorWhitespace.foreground": "#e3e4e229",
  },
  settings: [
    { settings: { foreground: "#BCBEC4" } },

    // Comments
    { scope: ["comment", "punctuation.definition.comment"], settings: { foreground: "#7A7E85" } },
    {
      scope: "comment.block.documentation",
      settings: { foreground: "#7A7E85", fontStyle: "italic" },
    },

    // Keywords & storage
    { scope: ["keyword", "storage.type", "storage.modifier"], settings: { foreground: "#6DA0CF" } },

    // Strings
    { scope: ["string", "punctuation.definition.string"], settings: { foreground: "#cf7c7c" } },
    // { scope: ["string", "punctuation.definition.string"], settings: { foreground: "#F68383" } },
    {
      scope: [
        "keyword.operator",
        "constant.character.escape",
        "punctuation.definition.template-expression.begin.tsx",
        "punctuation.definition.template-expression.end.tsx",
      ],
      settings: { foreground: "#D5B778" },
    },

    // Regex
    { scope: ["string.regexp", "source.regexp"], settings: { foreground: "#D16969" } },

    // Types
    {
      scope: ["meta.objectliteral.tsx", "entity.name.type", "support.type", "support.class"],
      settings: { foreground: "#BDBEC4" },
    },

    // Properties & attributes
    {
      scope: [
        "variable.other.property",
        "variable.other.object.property",
        "support.variable",
        "meta.object-literal.key",
      ],
      settings: { foreground: "#BDBEC4" },
    },

    // Variable language (this, self, super)
    { scope: "variable.language", settings: { foreground: "#CF8E6D" } },

    { scope: ["keyword.operator.expression.instanceof.tsx"], settings: { foreground: "#6DA0CF" } },

    // Constants
    {
      scope: [
        "constant",
        "constant.numeric",
        "constant.language",
        "constant.other",
        "variable.other.enummember",
      ],
      settings: { foreground: "#ed9c6d" },
    },

    // Tags (HTML/JSX)
    {
      scope: [
        "entity.name.tag",
        "punctuation.definition.tag",
        "punctuation.definition.tag.begin",
        "punctuation.definition.tag.end",
      ],
      settings: { foreground: "#93B196" },
    },

    // Punctuation & delimiters
    {
      scope: [
        "punctuation.separator",
        "punctuation.terminator",
        "meta.brace",
        "punctuation.section",
      ],
      settings: { foreground: "#93B196" },
    },

    // Operators
    { scope: ["entity.other.attribute-name"], settings: { foreground: "#BCBEC4" } },

    // Meta tags
    {
      scope: ["string.quoted.double.html", "meta.embedded.line", "meta.tag"],
      settings: { foreground: "#BCBEC4" },
    },

    // // HTML/JSX attribute values
    // {
    //   scope: ["string.quoted.double.html", "meta.embedded.line"],
    //   settings: { foreground: "#6AAB73" },
    // },

    // Import/export
    {
      scope: ["keyword.control.import", "keyword.control.export", "keyword.control.from"],
      settings: { foreground: "#6DA0CF" },
    },

    {
      scope: [
        "entity.name.function",
        "support.function",
        "support.class.component",
        "entity.name.type.enum",
        "entity.name.type.parameter",
        "entity.name.namespace",
        "entity.name.module",
      ],
      settings: { foreground: "#659488" },
    },

    // Markdown
    {
      scope: ["markup.heading", "markup.heading entity.name"],
      settings: { foreground: "#6DA0CF", fontStyle: "bold" },
    },
    { scope: "markup.italic", settings: { fontStyle: "italic" } },
    { scope: "markup.bold", settings: { fontStyle: "bold" } },
    { scope: "markup.inline.raw", settings: { foreground: "#F68383" } },
  ],
};
