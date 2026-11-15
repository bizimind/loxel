import type { LanguageRegistration } from "shiki";

/**
 * TextMate grammar for Java `.properties` files. Shiki's `properties` is only an alias of its INI
 * grammar, which misses `!` comments and `key:value`, reads `;` and `#` inside a value as comments,
 * and lets an apostrophe in a value open a string that runs over the following lines.
 *
 * Every line is a comment or a key, an optional `=` or `:`, and a value up to the end of the line,
 * which a trailing backslash continues onto the next one.
 */
export const JAVA_PROPERTIES_GRAMMAR: LanguageRegistration = {
  name: "java-properties",
  displayName: "Java Properties",
  scopeName: "source.java-properties",
  patterns: [
    { match: "^\\s*[#!].*$", name: "comment.line.java-properties" },
    {
      // Not `\s` around the key: it also matches the line's newline, so an empty value would take
      // the next line as its value.
      begin: "^[ \\t\\f]*((?:\\\\.|[^\\s=:\\\\])+)[ \\t\\f]*([=:])?[ \\t\\f]*",
      beginCaptures: {
        "1": { name: "entity.name.tag.java-properties" },
        "2": { name: "punctuation.separator.key-value.java-properties" },
      },
      // Not `$`, which also matches after the line's newline and so ends a continued value.
      end: "(?=\\n)",
      contentName: "string.unquoted.java-properties",
      patterns: [
        { match: "\\\\\\n", name: "constant.character.escape.line-continuation.java-properties" },
        { match: "\\\\(?:u[0-9a-fA-F]{4}|.)", name: "constant.character.escape.java-properties" },
      ],
    },
  ],
  repository: {},
};
