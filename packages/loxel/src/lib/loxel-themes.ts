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

/**
 * Light counterpart of `loxelDark`, in the JetBrains New UI Light (IntelliJ Light) palette with its
 * keyword, property, string and function colors a touch less saturated, so they sit calmly on white,
 * and numbers in a warm amber (as loxelDark's are orange) to set them apart from the keyword blue.
 * It follows loxelDark's scope groups, splitting a few where the light palette tells them apart.
 */
export const loxelLight: ThemeRegistrationRaw = {
  name: "loxel-light",
  type: "light",
  semanticHighlighting: true,
  colors: {
    "editor.foreground": "#1E1F22",
    "editor.selectionBackground": "#A3C3FA",
    "editorCursor.foreground": "#000000",
    "editorIndentGuide.background": "#C6CAD2",
    "editorIndentGuide.activeBackground": "#9DA2AE",
    "editorBracketMatch.background": "#93D9D980",
    "editorBracketMatch.border": "#00000000",
    "editorWhitespace.foreground": "#1E1F2233",
  },
  settings: [
    { settings: { foreground: "#1E1F22" } },

    // Comments
    {
      scope: ["comment", "punctuation.definition.comment"],
      settings: { foreground: "#747882", fontStyle: "italic" },
    },
    {
      scope: "comment.block.documentation",
      settings: { foreground: "#747882", fontStyle: "italic" },
    },

    // Keywords & storage
    { scope: ["keyword", "storage.type", "storage.modifier"], settings: { foreground: "#1F3A93" } },

    // Strings
    { scope: ["string", "punctuation.definition.string"], settings: { foreground: "#1F7A2B" } },
    { scope: ["keyword.operator"], settings: { foreground: "#1E1F22" } },
    // Word operators read as keywords
    {
      scope: ["keyword.operator.new", "keyword.operator.expression"],
      settings: { foreground: "#1F3A93" },
    },
    {
      scope: [
        "constant.character.escape",
        "punctuation.definition.template-expression.begin.tsx",
        "punctuation.definition.template-expression.end.tsx",
      ],
      settings: { foreground: "#0037A6" },
    },

    // Regex
    { scope: ["string.regexp", "source.regexp"], settings: { foreground: "#0037A6" } },
    {
      scope: [
        "constant.other.character-class.regexp",
        "constant.other.character-class.set.regexp",
        "keyword.operator.quantifier.regexp",
        "keyword.operator.negation.regexp",
      ],
      settings: { foreground: "#0037A6", fontStyle: "" },
    },

    // Types
    {
      scope: ["meta.objectliteral.tsx", "entity.name.type", "support.type", "support.class"],
      settings: { foreground: "#000000" },
    },

    // Properties & attributes
    {
      scope: [
        "variable.other.property",
        "variable.other.object.property",
        "support.variable",
        "meta.object-literal.key",
        // YAML keys are properties too; as tags they'd share the number blue's hue
        "entity.name.tag.yaml",
      ],
      settings: { foreground: "#85358C" },
    },

    // Variable language (this, super); Python's self/cls take the semantic self/cls color
    { scope: "variable.language", settings: { foreground: "#1F3A93" } },
    {
      scope: [
        "variable.language.special.self.python",
        "variable.parameter.function.language.special.self.python",
        "variable.language.special.cls.python",
        "variable.parameter.function.language.special.cls.python",
      ],
      settings: { foreground: "#94558D" },
    },

    { scope: ["keyword.operator.expression.instanceof.tsx"], settings: { foreground: "#1F3A93" } },

    // Constants
    { scope: ["constant", "constant.numeric"], settings: { foreground: "#A85400" } },
    { scope: "constant.language", settings: { foreground: "#1F3A93" } },
    { scope: "constant.other", settings: { foreground: "#85358C" } },
    {
      scope: "variable.other.enummember",
      settings: { foreground: "#85358C", fontStyle: "italic" },
    },

    // Tags (HTML/JSX)
    {
      scope: [
        "entity.name.tag",
        "punctuation.definition.tag",
        "punctuation.definition.tag.begin",
        "punctuation.definition.tag.end",
      ],
      settings: { foreground: "#1F3A93" },
    },

    // Punctuation & delimiters
    {
      scope: [
        "punctuation.separator",
        "punctuation.terminator",
        "meta.brace",
        "punctuation.section",
      ],
      settings: { foreground: "#1E1F22" },
    },

    // Attributes
    { scope: ["entity.other.attribute-name"], settings: { foreground: "#174AD4" } },

    // Meta tags
    { scope: ["meta.embedded.line", "meta.tag"], settings: { foreground: "#1E1F22" } },
    { scope: ["string.quoted.double.html"], settings: { foreground: "#1F7A2B" } },

    // Import/export
    {
      scope: ["keyword.control.import", "keyword.control.export", "keyword.control.from"],
      settings: { foreground: "#1F3A93" },
    },

    {
      scope: ["entity.name.function", "support.function", "support.class.component"],
      settings: { foreground: "#156275" },
    },
    {
      scope: ["entity.name.type.enum", "entity.name.namespace", "entity.name.module"],
      settings: { foreground: "#000000" },
    },
    { scope: "entity.name.type.parameter", settings: { foreground: "#007E8A" } },

    // Decorators and annotations
    {
      scope: ["meta.decorator", "entity.name.function.decorator", "storage.type.annotation"],
      settings: { foreground: "#9E880D" },
    },

    // Markdown
    {
      scope: ["markup.heading", "markup.heading entity.name"],
      settings: { foreground: "#1F3A93", fontStyle: "bold" },
    },
    { scope: "markup.italic", settings: { fontStyle: "italic" } },
    { scope: "markup.bold", settings: { fontStyle: "bold" } },
    { scope: "markup.inline.raw", settings: { foreground: "#1F7A2B" } },
    { scope: "markup.underline.link", settings: { foreground: "#2A5DD8" } },
  ],
};
