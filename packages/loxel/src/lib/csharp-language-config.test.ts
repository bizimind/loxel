import { type Mock, afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";

import { shikiToMonaco } from "@shikijs/monaco";
import * as monaco from "monaco-editor";
import { createHighlighter } from "shiki";

import { CSHARP_DOC_COMMENT_LINE, registerLanguageConfiguration } from "./csharp-language-config";
import { loxelDark } from "./loxel-themes";
import { registerLanguageConfiguration as registerPythonLanguageConfiguration } from "./python-language-config";

describe("CSHARP_DOC_COMMENT_LINE", () => {
  test.each(["///", "/// <summary>", "    /// text", "\t///text"])("matches %p", (line) => {
    expect(CSHARP_DOC_COMMENT_LINE.test(line)).toBe(true);
  });

  test.each(["// text", "//// not a doc comment", "int x; /// trailing", "/* /// */"])(
    "does not match %p",
    (line) => {
      expect(CSHARP_DOC_COMMENT_LINE.test(line)).toBe(false);
    },
  );
});

/** Internal model surface (not in monaco.d.ts) used to tokenize synchronously. */
interface InternalTextModel {
  tokenization: { forceTokenization(lineNumber: number): void };
}

/** Internal folding surface (not in monaco.d.ts): the model the folding contribution computes. */
interface FoldingContribution extends monaco.editor.IEditorContribution {
  getFoldingModel(): Promise<{
    regions: { length: number; getStartLineNumber(i: number): number };
  } | null>;
}

// Runs on Shiki's grammars, as the app does: Monaco's `notIn` checks read token types that the
// bridge derives from the theme, which Monarch's tokens would not exercise.
describe("C# and Razor editing in Monaco", () => {
  let container: HTMLElement;
  let editor: monaco.editor.IStandaloneCodeEditor;
  let restoreShikiPatches: () => void;

  /** Every configuration registered, in order: Monaco's built-in one and ours. */
  const configurations = new Map<string, monaco.languages.LanguageConfiguration[]>();
  let setConfigurationSpy: Mock<typeof monaco.languages.setLanguageConfiguration>;

  beforeAll(async () => {
    const { setTheme, create } = monaco.editor;
    const highlighter = await createHighlighter({
      themes: [loxelDark],
      langs: ["csharp", "razor"],
    });
    // No time limit: a tokenizer stopped early on a loaded machine would change the token types.
    shikiToMonaco(highlighter, monaco, { tokenizeTimeLimit: 0 });
    restoreShikiPatches = () => {
      monaco.editor.setTheme = setTheme;
      monaco.editor.create = create;
    };

    const setConfiguration = monaco.languages.setLanguageConfiguration;
    setConfigurationSpy = spyOn(monaco.languages, "setLanguageConfiguration").mockImplementation(
      (id, configuration) => {
        configurations.set(id, [...(configurations.get(id) ?? []), configuration]);
        return setConfiguration(id, configuration);
      },
    );
    const registered = registerLanguageConfiguration();
    // Installs the step-over hook, as `monaco-env.ts` does in the app.
    void registerPythonLanguageConfiguration();
    container = document.createElement("div");
    document.body.append(container);
    const csharpModel = monaco.editor.createModel("", "csharp");
    const razorModel = monaco.editor.createModel("", "razor");
    editor = monaco.editor.create(container, {
      model: csharpModel,
      insertSpaces: true,
      tabSize: 4,
      // Headless DOM has no canvas.
      minimap: { enabled: false },
      overviewRulerLanes: 0,
    });
    await registered;
    razorModel.dispose();
  });

  afterAll(() => {
    setConfigurationSpy.mockRestore();
    restoreShikiPatches();
    const model = editor.getModel();
    editor.dispose();
    model?.dispose();
    container.remove();
  });

  /** Opens `content` in `language` with the cursor at the end of the last line. */
  function open(language: string, content: string): monaco.editor.ITextModel {
    editor.getModel()?.dispose();
    const model = monaco.editor.createModel(content, language);
    editor.setModel(model);
    const lastLine = model.getLineCount();
    editor.setPosition({ lineNumber: lastLine, column: model.getLineMaxColumn(lastLine) });
    return model;
  }

  /** Types through the textarea keydown, so the step-over hook sees each key. */
  function type(text: string): void {
    const input = container.querySelector("textarea")!;
    for (const ch of text) {
      // Rendering tokenizes visible lines; headless, Monaco skips auto-close and on-enter rules on
      // untokenized lines.
      (editor.getModel() as unknown as InternalTextModel).tokenization.forceTokenization(
        editor.getPosition()?.lineNumber ?? 1,
      );
      const keydown = new KeyboardEvent("keydown", { key: ch, cancelable: true });
      input.dispatchEvent(keydown);
      if (!keydown.defaultPrevented) editor.trigger("keyboard", "type", { text: ch });
    }
  }

  function typeAtEnd(initial: string, text: string, language = "csharp"): string {
    const model = open(language, initial);
    type(text);
    return model.getValue();
  }

  // Each registration overrides the fields it sets, so a Monaco upgrade that registers its own
  // configuration later (or no longer exposes it) would silently drop ours.
  test("registers its C# configuration last, over Monaco's built-in one", () => {
    const registered = configurations.get("csharp") ?? [];
    expect(registered).toHaveLength(2);
    const [builtin, ours] = registered;
    expect(builtin?.onEnterRules).toBeUndefined();
    expect(ours?.autoClosingPairs?.some((p) => p.open === '"""')).toBe(true);
    expect(ours?.folding).toEqual(builtin?.folding);
  });

  test("registers its Razor configuration last, over Monaco's built-in one", () => {
    const registered = configurations.get("razor") ?? [];
    expect(registered).toHaveLength(2);
    const [builtin, ours] = registered;
    expect(builtin?.comments?.blockComment).toEqual(["<!--", "-->"]);
    expect(ours?.comments?.blockComment).toEqual(["@*", "*@"]);
    expect(ours?.onEnterRules).toEqual(builtin?.onEnterRules);
  });

  describe("doc comments", () => {
    test("continues a /// comment on Enter", () => {
      expect(typeAtEnd("/// <summary>", "\n")).toBe("/// <summary>\n/// ");
    });

    test("keeps the indent of a /// comment", () => {
      expect(typeAtEnd("class C\n{\n    /// text", "\n")).toBe(
        "class C\n{\n    /// text\n    /// ",
      );
    });

    test("does not continue //// or a plain // comment", () => {
      expect(typeAtEnd("//// text", "\n")).toBe("//// text\n");
      expect(typeAtEnd("// text", "\n")).toBe("// text\n");
    });

    test("does not add a /// when Enter is before the comment", () => {
      const model = open("csharp", "    /// text");
      editor.setPosition({ lineNumber: 1, column: 3 });
      type("\n");
      expect(model.getLineContent(2).trimStart()).toBe("/// text");
    });

    test("continues a /** block comment on Enter", () => {
      const model = open("csharp", "    /**");
      type("\n");
      expect(model.getLineContent(2)).toBe("     * ");
      type("text\n");
      expect(model.getLineContent(3)).toBe("     * ");
    });

    test("expands /** */ around the cursor on Enter", () => {
      const model = open("csharp", "/** */");
      editor.setPosition({ lineNumber: 1, column: 4 });
      type("\n");
      expect(model.getValue()).toBe("/**\n * \n */");
    });
  });

  describe("raw strings", () => {
    test.each([
      ["var s = ", `"""`, `var s = """"""`],
      ["var s = ", `$"""`, `var s = $""""""`],
      ["var s = ", `$$"""`, `var s = $$""""""`],
    ])("auto-closes %p + %p", (initial, typed, result) => {
      expect(typeAtEnd(initial, typed)).toBe(result);
    });

    test("puts the cursor between the delimiters", () => {
      typeAtEnd("var s = ", `"""`);
      expect(editor.getPosition()?.column).toBe(12);
    });

    test("types over the whole closing delimiter", () => {
      expect(typeAtEnd("var s = ", `"""a"""`)).toBe(`var s = """a"""`);
      expect(editor.getPosition()?.column).toBe(16);
    });

    test("types over the rest of a closing delimiter it did not insert", () => {
      const model = open("csharp", `var s = """a"""`);
      editor.setPosition({ lineNumber: 1, column: 14 }); // after the first closing quote
      type(`""`);
      expect(model.getValue()).toBe(`var s = """a"""`);
      expect(editor.getPosition()?.column).toBe(16);
    });

    test("types an unindented closing delimiter by hand in a multi-line raw string", () => {
      expect(typeAtEnd(`var s = """\nbody\n`, `"""`)).toBe(`var s = """\nbody\n"""`);
      expect(typeAtEnd(`var s = """\nbody\n\n`, `"""`)).toBe(`var s = """\nbody\n\n"""`);
    });

    test("opens a raw string at the start of the first line", () => {
      expect(typeAtEnd(``, `"""`)).toBe(`""""""`);
    });

    test("does not auto-close triple quotes in comments", () => {
      expect(typeAtEnd("// ", `"""`)).toBe(`// """`);
      expect(typeAtEnd("/// ", `"""`)).toBe(`/// """`);
    });

    test("puts the closing delimiter on its own line on Enter", () => {
      const model = open("csharp", `var s = `);
      type(`"""\n`);
      expect(model.getValue()).toBe(`var s = """\n    \n"""`);
      expect(editor.getPosition()?.lineNumber).toBe(2);
    });

    test("types a closing delimiter by hand in a multi-line raw string", () => {
      expect(typeAtEnd(`var s = """\n    body\n    `, `"""`)).toBe(
        `var s = """\n    body\n    """`,
      );
    });
  });

  describe("interpolated and verbatim strings", () => {
    test.each([
      [`var s = `, `$"`, `var s = $""`],
      [`var s = `, `@"`, `var s = @""`],
      [`var s = `, `$@"`, `var s = $@""`],
      [`var s = `, `@$"`, `var s = @$""`],
    ])("auto-closes %p + %p", (initial, typed, result) => {
      expect(typeAtEnd(initial, typed)).toBe(result);
    });

    test("types over the closing quote", () => {
      expect(typeAtEnd(`var s = `, `$"a"`)).toBe(`var s = $"a"`);
      expect(typeAtEnd(`var s = `, `@"a"`)).toBe(`var s = @"a"`);
    });

    test("auto-closes an interpolation hole", () => {
      expect(typeAtEnd(`var s = `, `$"{`)).toBe(`var s = $"{}"`);
    });

    test("treats a quote at the start of a line by the line before it", () => {
      expect(typeAtEnd(`var s = @"say\n`, `"";`)).toBe(`var s = @"say\n"";`);
      expect(typeAtEnd(`var a = 1;\n`, `"""`)).toBe(`var a = 1;\n""""""`);
    });

    test("types an escaped quote at the end of a verbatim string", () => {
      expect(typeAtEnd(`var s = `, `@"say ""hi"""`)).toBe(`var s = @"say ""hi"""`);
      expect(editor.getPosition()?.column).toBe(22);
    });

    test("leaves a quote another keydown hook has handled alone", () => {
      const model = open("csharp", `var s = @"a""`);
      (model as unknown as InternalTextModel).tokenization.forceTokenization(1);
      const handled = (e: Event) => e.preventDefault();
      container.addEventListener("keydown", handled, { capture: true });
      try {
        container
          .querySelector("textarea")!
          .dispatchEvent(
            new KeyboardEvent("keydown", { key: '"', bubbles: true, cancelable: true }),
          );
      } finally {
        container.removeEventListener("keydown", handled, { capture: true });
      }
      expect(model.getValue()).toBe(`var s = @"a""`);
    });

    test("types an escaped quote on a later line of a verbatim string", () => {
      expect(typeAtEnd(`var s = @"line one\nsay `, `""hi"""`)).toBe(
        `var s = @"line one\nsay ""hi"""`,
      );
    });

    test("ignores quotes in character literals when telling strings apart", () => {
      expect(typeAtEnd(`var q = '"'; var s = @"a`, `"""`)).toBe(`var q = '"'; var s = @"a"""`);
      expect(typeAtEnd(`var q = '"'; var s = `, `"""`)).toBe(`var q = '"'; var s = """"""`);
    });

    test("still opens a raw string after another string on the line", () => {
      expect(typeAtEnd(`Foo("", `, `"""`)).toBe(`Foo("", """"""`);
      expect(typeAtEnd(`Foo("", `, `$"""`)).toBe(`Foo("", $""""""`);
    });

    test("does not auto-close a quote typed inside a string", () => {
      expect(typeAtEnd(`var s = "a`, `"`)).toBe(`var s = "a"`);
    });
  });

  test("keeps the built-in pairs", () => {
    expect(typeAtEnd("Foo", "(")).toBe("Foo()");
    expect(typeAtEnd("var c = ", "'")).toBe("var c = ''");
  });

  test("keeps the indent after an opening brace", () => {
    expect(typeAtEnd("class C\n{", "\n")).toBe("class C\n{\n    ");
  });

  test("folds #region blocks", async () => {
    open(
      "csharp",
      "class C\n{\n    #region Fields\n    int a;\n    int b;\n    #endregion\n\n    int c;\n}\n",
    );
    const folding = editor.getContribution<FoldingContribution>("editor.contrib.folding");
    const foldingModel = await folding?.getFoldingModel();
    const { regions } = foldingModel ?? {};
    const starts = Array.from({ length: regions?.length ?? 0 }, (_, i) =>
      regions?.getStartLineNumber(i),
    );
    expect(starts).toContain(3);
  });

  describe("Razor", () => {
    test("toggles a Razor comment", () => {
      const model = open("razor", "<p>text</p>");
      editor.trigger("keyboard", "editor.action.commentLine", null);
      expect(model.getValue()).toBe("@* <p>text</p> *@");
    });

    // Monaco would not overtype the `*` of a closer, so an auto-closed one would be left behind.
    test("types a Razor comment out without a stray closer", () => {
      expect(typeAtEnd("", "@* x *@", "razor")).toBe("@* x *@");
    });

    test("auto-closes brackets and quotes", () => {
      expect(typeAtEnd("@Foo", "(", "razor")).toBe("@Foo()");
      expect(typeAtEnd("<a href=", `"`, "razor")).toBe(`<a href=""`);
    });

    test("surrounds a selection with brackets", () => {
      const model = open("razor", "text");
      editor.setSelection(new monaco.Range(1, 1, 1, 5));
      editor.trigger("keyboard", "type", { text: "[" });
      expect(model.getValue()).toBe("[text]");
    });

    test("indents between an opening and closing tag on Enter", () => {
      const model = open("razor", "<div></div>");
      editor.setPosition({ lineNumber: 1, column: 6 });
      type("\n");
      expect(model.getValue()).toBe("<div>\n    \n</div>");
    });
  });
});
