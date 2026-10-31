import { type Mock, afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";

import { shikiToMonaco } from "@shikijs/monaco";
import * as monaco from "monaco-editor";

import { getHighlighter } from "./highlighter";
import { closingTextBlockAction, registerLanguageConfiguration } from "./java-language-config";
import { registerLanguageConfiguration as registerPythonLanguageConfiguration } from "./python-language-config";

/** Internal model surface (not in monaco.d.ts) used to tokenize synchronously. */
interface InternalTextModel {
  tokenization: { forceTokenization(lineNumber: number): void };
}

describe("Java editing in Monaco", () => {
  let container: HTMLElement;
  let editor: monaco.editor.IStandaloneCodeEditor;

  /** Every Java configuration registered, in order: Monaco's built-in one and ours. */
  const javaConfigurations: monaco.languages.LanguageConfiguration[] = [];
  let setConfigurationSpy: Mock<typeof monaco.languages.setLanguageConfiguration>;

  beforeAll(async () => {
    const setConfiguration = monaco.languages.setLanguageConfiguration;
    setConfigurationSpy = spyOn(monaco.languages, "setLanguageConfiguration").mockImplementation(
      (id, configuration) => {
        if (id === "java") javaConfigurations.push(configuration);
        return setConfiguration(id, configuration);
      },
    );
    const registered = registerLanguageConfiguration();
    void registerPythonLanguageConfiguration(); // owns the triple-quote keydown hook
    container = document.createElement("div");
    document.body.append(container);
    const model = monaco.editor.createModel("", "java");
    editor = monaco.editor.create(container, {
      model,
      insertSpaces: true,
      tabSize: 4,
      detectIndentation: false,
      // Headless DOM has no canvas.
      minimap: { enabled: false },
      overviewRulerLanes: 0,
    });
    await registered;
    // The app tokenizes Java with Shiki's grammar, and the `notIn` checks read those tokens.
    shikiToMonaco(await getHighlighter(), monaco);
    monaco.editor.setTheme("loxel-dark");
  });

  afterAll(() => {
    setConfigurationSpy.mockRestore();
    const model = editor.getModel();
    editor.dispose();
    model?.dispose();
    container.remove();
  });

  // Each registration overrides the fields it sets, so a Monaco upgrade that registers its own
  // configuration later (or no longer exposes it) would silently drop ours.
  test("registers its configuration last, over Monaco's built-in one", () => {
    expect(javaConfigurations).toHaveLength(2);
    const [builtin, ours] = javaConfigurations;
    expect(builtin?.autoClosingPairs?.some((p) => p.open === '"""')).toBe(false);
    expect(builtin?.onEnterRules).toBeUndefined();
    expect(builtin?.indentationRules).toBeUndefined();
    expect(ours?.autoClosingPairs?.some((p) => p.open === '"""')).toBe(true);
    expect(ours?.onEnterRules?.length).toBeGreaterThan(0);
    expect(ours?.indentationRules).toBeDefined();
    expect(ours?.folding).toEqual(builtin?.folding);
  });

  /** Sets the content, puts the cursor at the end, then types through the textarea keydown. */
  function typeAtEnd(initial: string, text: string): string {
    const model = editor.getModel()!;
    model.setValue(initial);
    const lastLine = model.getLineCount();
    // Rendering tokenizes visible lines; headless, Monaco skips auto-close on untokenized lines.
    (model as unknown as InternalTextModel).tokenization.forceTokenization(lastLine);
    editor.setPosition({ lineNumber: lastLine, column: model.getLineMaxColumn(lastLine) });
    const input = container.querySelector("textarea")!;
    for (const ch of text) {
      const keydown = new KeyboardEvent("keydown", { key: ch, cancelable: true });
      input.dispatchEvent(keydown);
      if (!keydown.defaultPrevented) editor.trigger("keyboard", "type", { text: ch });
    }
    return model.getValue();
  }

  describe("comments", () => {
    test("completes a Javadoc comment and continues it on Enter", () => {
      expect(typeAtEnd("    ", "/**")).toBe("    /** */");
      expect(typeAtEnd("    ", "/**\n")).toBe("    /**\n     * \n     */");
    });

    test("continues a Javadoc comment already opened on the line", () => {
      expect(typeAtEnd("/** Summary.", "\n")).toBe("/** Summary.\n * ");
    });

    test("continues a block comment on Enter", () => {
      expect(typeAtEnd("    /* note", "\n")).toBe("    /* note\n     * ");
      expect(typeAtEnd("/*\n * first", "\n")).toBe("/*\n * first\n * ");
    });

    test("does not continue a closed block comment", () => {
      expect(typeAtEnd("/* note */", "\n")).toBe("/* note */\n");
    });

    test("returns to the code indent after the end of a comment", () => {
      expect(typeAtEnd("    /**\n     * Doc.\n     */", "\n")).toBe(
        "    /**\n     * Doc.\n     */\n    ",
      );
    });
  });

  describe("text blocks", () => {
    test("auto-close, with the closing delimiter at the content's indent on Enter", () => {
      const opening = '    String s = """';
      expect(typeAtEnd("    String s = ", '"""')).toBe(`${opening}"""`);
      expect(typeAtEnd("    String s = ", '"""\n')).toBe(`${opening}\n        """`);
    });

    test("type over the whole closing delimiter", () => {
      expect(typeAtEnd("String s = ", '"""a"""')).toBe('String s = """a"""');
      expect(editor.getPosition()?.column).toBe(19);
    });

    test("typing the closing delimiter of a multi-line block lands on the one already there", () => {
      const closed = 'String s = """\n    hello\n    """';
      expect(typeAtEnd("String s = ", '"""\nhello\n"""')).toBe(closed);
      expect(editor.getPosition()).toMatchObject({ lineNumber: 3, column: 8 });
      expect(typeAtEnd("String s = ", '"""\nhello"""')).toBe('String s = """\n    hello"""');
    });

    test("closing a block with no closing delimiter adds only what was typed", () => {
      expect(typeAtEnd('String s = """\n    a\n    ', '"""')).toBe(
        'String s = """\n    a\n    """',
      );
    });

    test("an escaped backslash before the closing delimiter does not escape it", () => {
      const open = 'String s = """\n    C:\\\\Users\\\\';
      expect(typeAtEnd(open, '"""')).toBe(`${open}"""`);
      expect(typeAtEnd("String s = ", '"""\nC:\\\\"""')).toBe('String s = """\n    C:\\\\"""');
    });

    test("a quote before an escaped backslash does not stop the delimiter closing", () => {
      const open = 'String s = """\n    say "\\\\';
      expect(typeAtEnd(open, '"""')).toBe(`${open}"""`);
    });

    test("a fourth quote is not treated as completing a delimiter", () => {
      expect(closingTextBlockAction('String s = """', "")).toBeNull();
    });

    test("an escaped backslash before a delimiter keeps later blocks counted", () => {
      const first = 'String a = """\n    C:\\\\""";\nString b = ';
      expect(typeAtEnd(first, '"""')).toBe(`${first}""""""`);
      expect(typeAtEnd(`${first}"""\n    x\n    `, '"""')).toBe(`${first}"""\n    x\n    """`);
    });

    test("an escaped quote does not complete a closing delimiter", () => {
      const open = 'String s = """\n    a\\"';
      expect(closingTextBlockAction(`${open}"`, "")).toBeNull();
      expect(closingTextBlockAction(`${open}""`, "")).toBeNull();
      expect(closingTextBlockAction('String s = """\n    a\\\\""', "")).toBe("insert");
    });

    test("a quote typed before the closing delimiter stays in the content", () => {
      expect(typeAtEnd("String s = ", '"""\n{"a')).toBe('String s = """\n    {"a"""');
    });

    test("a later text block auto-closes after a finished one", () => {
      const first = 'String a = """\n    x\n    """;\nString b = ';
      expect(typeAtEnd(first, '"""')).toBe(`${first}""""""`);
    });

    test("Enter after a lone delimiter does not indent", () => {
      expect(typeAtEnd('String s = """\n    x\n    """', "\n")).toBe(
        'String s = """\n    x\n    """\n    ',
      );
    });

    test("do not auto-close in comments", () => {
      expect(typeAtEnd("// ", '"""')).toBe('// """');
      expect(typeAtEnd("/* ", '"""')).toBe('/* """');
    });
  });

  describe("quotes", () => {
    test("auto-close in code", () => {
      expect(typeAtEnd("char c = ", "'")).toBe("char c = ''");
      expect(typeAtEnd("String s = ", '"')).toBe('String s = ""');
    });

    test("do not auto-close inside a string", () => {
      // A space before the quote: Monaco never auto-closes a quote right after a word character.
      expect(typeAtEnd('String s = "it ', "'")).toBe(`String s = "it '`);
      expect(typeAtEnd('String s = "a ', '"')).toBe('String s = "a "');
    });

    test("an apostrophe does not auto-close in a comment", () => {
      expect(typeAtEnd("// ", "'")).toBe("// '");
      expect(typeAtEnd("/** ", "'")).toBe("/** '");
    });

    test("/** does not complete inside a string", () => {
      expect(typeAtEnd('String s = "', "/**")).toBe('String s = "/**');
    });
  });

  describe("indentation", () => {
    test("keeps the built-in pairs", () => {
      expect(typeAtEnd("foo", "(")).toBe("foo()");
      expect(typeAtEnd("int[] a = ", "{")).toBe("int[] a = {}");
    });

    test("indents after an opening brace and dedents a typed closing brace", () => {
      expect(typeAtEnd("class A {", "\n")).toBe("class A {\n    ");
      expect(typeAtEnd("class A {\n    ", "}")).toBe("class A {\n}");
    });

    /** Runs Reindent Lines, the one path that applies `indentationRules` at Monaco's default `autoIndent`. */
    function reindent(lines: string[]): string[] {
      const model = editor.getModel()!;
      typeAtEnd(lines.join("\n"), "");
      editor.trigger("keyboard", "editor.action.reindentlines", null);
      return model.getLinesContent();
    }

    test("reindents blocks", () => {
      expect(reindent(["class A {", "void f() {", "g();", "}", "}"])).toEqual([
        "class A {",
        "    void f() {",
        "        g();",
        "    }",
        "}",
      ]);
    });

    test("a call continued over lines does not shift the code after it when reindenting", () => {
      const lines = reindent(["void f() {", "g(a,", "b);", "h(", "c", ");", "i();", "}"]);
      expect(lines.slice(-2)).toEqual(["    i();", "}"]);
    });

    test("reindenting ignores braces in strings and comments", () => {
      const code = ['String s = "{";', "// see {", "/* { */", "int a;"];
      expect(reindent(code)).toEqual(code);
    });

    test("a Javadoc comment does not shift the code after it when reindenting", () => {
      const lines = reindent(["class A {", "/**", " * Doc.", " */", "void f() {", "}", "}"]);
      expect(lines.slice(4)).toEqual(["    void f() {", "    }", "}"]);
    });

    test("reindenting leaves text block content alone", () => {
      const code = ["class A {", '    String s = """', "  {", "      a", '      """;', "}"];
      expect(reindent(code).slice(2, 4)).toEqual(["  {", "      a"]);
    });
  });
});
