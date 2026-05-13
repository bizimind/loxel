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
    { scope: ["string", "punctuation.definition.string"], settings: { foreground: "#F68383" } },
    { scope: ["constant.character.escape"], settings: { foreground: "#D5B778" } },

    // Numbers
    { scope: "constant.numeric", settings: { foreground: "#2AACB8" } },

    // Regex
    { scope: ["string.regexp", "source.regexp"], settings: { foreground: "#D16969" } },

    // Types
    {
      scope: ["entity.name.type", "support.type", "support.class"],
      settings: { foreground: "#BDBEC4" },
    },

    // Functions
    {
      scope: ["entity.name.function", "support.function", "meta.function-call"],
      settings: { foreground: "#57A8F5" },
    },

    // Properties & attributes
    {
      scope: [
        "variable.other.property",
        "variable.other.object.property",
        "support.variable",
        "meta.object-literal.key",
      ],
      settings: { foreground: "#C87DBB" },
    },

    // Variable language (this, self, super)
    { scope: "variable.language", settings: { foreground: "#CF8E6D" } },

    // Constants
    {
      scope: ["constant", "constant.language", "constant.other", "variable.other.enummember"],
      settings: { foreground: "#C77DBB" },
    },

    // Tags (HTML/JSX)
    {
      scope: ["entity.name.tag", "punctuation.definition.tag"],
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
    {
      scope: ["keyword.operator", "entity.other.attribute-name"],
      settings: { foreground: "#BCBEC4" },
    },

    // Meta tags
    {
      scope: ["meta.tag", "punctuation.definition.tag.begin", "punctuation.definition.tag.end"],
      settings: { foreground: "#93B196" },
    },

    // HTML/JSX attribute values
    {
      scope: ["string.quoted.double.html", "meta.embedded.line"],
      settings: { foreground: "#6AAB73" },
    },

    // Import/export
    {
      scope: ["keyword.control.import", "keyword.control.export", "keyword.control.from"],
      settings: { foreground: "#6DA0CF" },
    },

    // JSX component names (PascalCase tags)
    { scope: "support.class.component", settings: { foreground: "#30BBA2" } },

    // Namespace / module
    { scope: ["entity.name.namespace", "entity.name.module"], settings: { foreground: "#2FBAA3" } },

    // Type parameters
    { scope: "entity.name.type.parameter", settings: { foreground: "#2FBAA3" } },

    // Enum names
    { scope: "entity.name.type.enum", settings: { foreground: "#2FBAA3" } },

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

export const loxelLight: ThemeRegistrationRaw = {
  name: "loxel-light",
  type: "light",
  semanticHighlighting: true,
  colors: { "editor.foreground": "#000000" },
  settings: [
    { settings: { foreground: "#000000" } },

    // Comments
    { scope: ["comment", "punctuation.definition.comment"], settings: { foreground: "#6A737D" } },
    {
      scope: "comment.block.documentation",
      settings: { foreground: "#6A737D", fontStyle: "italic" },
    },

    // Keywords
    { scope: ["keyword", "storage.type", "storage.modifier"], settings: { foreground: "#0000FF" } },

    // Strings
    { scope: ["string", "punctuation.definition.string"], settings: { foreground: "#A31515" } },
    { scope: "constant.character.escape", settings: { foreground: "#EE0000" } },

    // Numbers
    { scope: "constant.numeric", settings: { foreground: "#098658" } },

    // Regex
    { scope: ["string.regexp", "source.regexp"], settings: { foreground: "#811F3F" } },

    // Types
    {
      scope: ["entity.name.type", "support.type", "support.class"],
      settings: { foreground: "#267F99" },
    },

    // Functions
    {
      scope: ["entity.name.function", "support.function", "meta.function-call"],
      settings: { foreground: "#795E26" },
    },

    // Properties & attributes
    {
      scope: [
        "variable.other.property",
        "variable.other.object.property",
        "entity.other.attribute-name",
        "support.variable",
        "meta.object-literal.key",
      ],
      settings: { foreground: "#E50000" },
    },

    // Variable language
    { scope: "variable.language", settings: { foreground: "#0000FF" } },

    // Constants
    {
      scope: ["constant", "constant.language", "constant.other", "variable.other.enummember"],
      settings: { foreground: "#0000FF" },
    },

    // Tags
    {
      scope: ["entity.name.tag", "punctuation.definition.tag"],
      settings: { foreground: "#800000" },
    },

    // Punctuation
    {
      scope: [
        "punctuation.separator",
        "punctuation.terminator",
        "meta.brace",
        "punctuation.section",
      ],
      settings: { foreground: "#000000" },
    },

    // Operators
    { scope: "keyword.operator", settings: { foreground: "#000000" } },

    // Meta tags
    {
      scope: ["meta.tag", "punctuation.definition.tag.begin", "punctuation.definition.tag.end"],
      settings: { foreground: "#800000" },
    },

    // Import/export
    {
      scope: ["keyword.control.import", "keyword.control.export", "keyword.control.from"],
      settings: { foreground: "#0000FF" },
    },

    // JSX components
    { scope: "support.class.component", settings: { foreground: "#267F99" } },

    // Namespace / module
    { scope: ["entity.name.namespace", "entity.name.module"], settings: { foreground: "#267F99" } },

    // Markdown
    {
      scope: ["markup.heading", "markup.heading entity.name"],
      settings: { foreground: "#0000FF", fontStyle: "bold" },
    },
    { scope: "markup.italic", settings: { fontStyle: "italic" } },
    { scope: "markup.bold", settings: { fontStyle: "bold" } },
    { scope: "markup.inline.raw", settings: { foreground: "#A31515" } },
  ],
};
