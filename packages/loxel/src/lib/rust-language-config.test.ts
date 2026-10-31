import { type Mock, afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";

import * as monaco from "monaco-editor";

import { registerLanguageConfiguration } from "./rust-language-config";

/** Internal model surface (not in monaco.d.ts) used to tokenize synchronously. */
interface InternalTextModel {
  tokenization: { forceTokenization(lineNumber: number): void };
}

describe("Rust editing in Monaco", () => {
  let container: HTMLElement;
  let editor: monaco.editor.IStandaloneCodeEditor;

  /** Every Rust configuration registered, in order: Monaco's built-in one and ours. */
  const rustConfigurations: monaco.languages.LanguageConfiguration[] = [];
  let setConfigurationSpy: Mock<typeof monaco.languages.setLanguageConfiguration>;

  beforeAll(async () => {
    const setConfiguration = monaco.languages.setLanguageConfiguration;
    setConfigurationSpy = spyOn(monaco.languages, "setLanguageConfiguration").mockImplementation(
      (id, configuration) => {
        if (id === "rust") rustConfigurations.push(configuration);
        return setConfiguration(id, configuration);
      },
    );
    const registered = registerLanguageConfiguration();
    container = document.createElement("div");
    document.body.append(container);
    const model = monaco.editor.createModel("", "rust");
    editor = monaco.editor.create(container, {
      model,
      insertSpaces: true,
      tabSize: 4,
      // Headless DOM has no canvas.
      minimap: { enabled: false },
      overviewRulerLanes: 0,
    });
    await registered;
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
    expect(rustConfigurations).toHaveLength(2);
    const [builtin, ours] = rustConfigurations;
    expect(builtin?.onEnterRules).toBeUndefined();
    expect(ours?.onEnterRules?.length).toBeGreaterThan(0);
    expect(ours?.comments).toEqual(builtin?.comments);
    expect(ours?.brackets).toEqual(builtin?.brackets);
  });

  /** Sets the content (a `|` marks the cursor, default at the end) and types `text` there. */
  function type(marked: string, text: string): string {
    const model = editor.getModel()!;
    const marker = marked.indexOf("|");
    const offset = marker === -1 ? marked.length : marker;
    model.setValue(marked.slice(0, offset) + marked.slice(offset + 1));
    // Rendering tokenizes visible lines; headless, Monaco skips auto-close on untokenized lines.
    (model as unknown as InternalTextModel).tokenization.forceTokenization(model.getLineCount());
    editor.setPosition(model.getPositionAt(offset));
    const input = container.querySelector("textarea")!;
    for (const ch of text) {
      const keydown = new KeyboardEvent("keydown", { key: ch, cancelable: true });
      input.dispatchEvent(keydown);
      if (!keydown.defaultPrevented) editor.trigger("keyboard", "type", { text: ch });
    }
    return model.getValue();
  }

  /** The result of typing `text`, with `|` at the resulting cursor. */
  function typeShowingCursor(marked: string, text: string): string {
    const value = type(marked, text);
    const offset = editor.getModel()!.getOffsetAt(editor.getPosition()!);
    return `${value.slice(0, offset)}|${value.slice(offset)}`;
  }

  describe("Enter in line doc comments", () => {
    test.each([
      ["/// Adds.", "/// Adds.\n/// |"],
      ["///", "///\n/// |"],
      ["    /// Adds.", "    /// Adds.\n    /// |"],
      ["//! Crate docs.", "//! Crate docs.\n//! |"],
      ["    //! Module docs.", "    //! Module docs.\n    //! |"],
      ["/// Adds| two.", "/// Adds\n/// | two."],
    ])("%p", (before, after) => {
      expect(typeShowingCursor(before, "\n")).toBe(after);
    });

    test.each([
      ["// A comment.", "// A comment.\n|"],
      ["//// Not a doc comment.", "//// Not a doc comment.\n|"],
      ["let x = 1; /// Not a doc comment.", "let x = 1; /// Not a doc comment.\n|"],
      ["let p = 1; //! Nor this.", "let p = 1; //! Nor this.\n|"],
    ])("does not continue %p", (before, after) => {
      expect(typeShowingCursor(before, "\n")).toBe(after);
    });
  });

  describe("Enter in block doc comments", () => {
    test.each([
      ["/** Adds.", "/** Adds.\n * |"],
      ["/*! Crate docs.", "/*! Crate docs.\n * |"],
      ["    /** Adds.", "    /** Adds.\n     * |"],
      ["/**| */", "/**\n * |\n */"],
      ["/** | */", "/** \n * |\n */"],
      ["    /**| */", "    /**\n     * |\n     */"],
      ["/**\n * Adds.", "/**\n * Adds.\n * |"],
      ["    /**\n     * Adds.", "    /**\n     * Adds.\n     * |"],
      ["/**\n * One.\n * Two.", "/**\n * One.\n * Two.\n * |"],
      ["/**\n * Adds.\n */", "/**\n * Adds.\n */\n|"],
      ["    /**\n     * Adds.\n     */", "    /**\n     * Adds.\n     */\n    |"],
      ["    /**\n     * Adds. */", "    /**\n     * Adds. */\n    |"],
      ["    /**\n     * See a/b. */", "    /**\n     * See a/b. */\n    |"],
    ])("%p", (before, after) => {
      expect(typeShowingCursor(before, "\n")).toBe(after);
    });

    test("continues a comment indented with tabs", () => {
      const model = editor.getModel()!;
      model.updateOptions({ insertSpaces: false });
      try {
        expect(typeShowingCursor("\t/**\n\t * Adds.", "\n")).toBe("\t/**\n\t * Adds.\n\t * |");
      } finally {
        model.updateOptions({ insertSpaces: true });
      }
    });

    test.each([
      ["/** Done. */", "/** Done. */\n|"],
      ["/**/", "/**/\n|"],
      ["/* Plain.", "/* Plain.\n|"],
    ])("does not continue %p", (before, after) => {
      expect(typeShowingCursor(before, "\n")).toBe(after);
    });

    test.each([
      // How rustfmt breaks long expressions: at the operator, at an even indent.
      ["let n = a\n    * b", "let n = a\n    * b\n    |"],
      ["let n = a\n    * b\n    * c", "let n = a\n    * b\n    * c\n    |"],
      ["let n = a\n     * b", "let n = a\n     * b\n     |"],
      ["    *x = 1;", "    *x = 1;\n    |"],
      [" *x = 1;", " *x = 1;\n |"],
    ])("leaves multiplication and dereference alone: %p", (before, after) => {
      expect(typeShowingCursor(before, "\n")).toBe(after);
    });
  });

  describe("auto-closing", () => {
    test.each([
      ["", "/**", "/** */"],
      ["    ", "/**", "    /** */"],
      ["", "/*!", "/*! */"],
      ["", "/**\n", "/**\n * \n */"],
    ])("closes block doc comments after %p", (before, typed, after) => {
      expect(type(before, typed)).toBe(after);
    });

    test("does not close them in strings", () => {
      expect(type('let s = "', "/**")).toBe('let s = "/**');
    });

    test.each([
      ["/** Doc. */", "/** Doc. */|"],
      ["/*! Doc. */", "/*! Doc. */|"],
      ["/**/", "/**/|"],
    ])("typing the end of a comment replaces the auto-closed one: %p", (typed, after) => {
      expect(typeShowingCursor("", typed)).toBe(after);
    });

    test("leaves a `/` elsewhere in an auto-closed comment alone", () => {
      expect(typeShowingCursor("/** a/b", "/")).toBe("/** a/b/|");
      expect(typeShowingCursor("/** a| */", "/")).toBe("/** a/| */");
    });

    test.each([
      ["let x = 1; ", "/** n */", "let x = 1; /** n */|"],
      ["fn f(| x: i32)", "/** doc */", "fn f(/** doc */| x: i32)"],
      ["impl T { |}", "/** doc */", "impl T { /** doc */|}"],
    ])("replaces the auto-closed end of a mid-line comment: %p", (before, typed, after) => {
      expect(typeShowingCursor(before, typed)).toBe(after);
    });

    test.each([
      ['let s = "/** x *| */";', 'let s = "/** x */| */";'],
      ['let a = "/*! y *| */";', 'let a = "/*! y */| */";'],
    ])("keeps what the user typed in a string: %p", (before, after) => {
      expect(typeShowingCursor(before, "/")).toBe(after);
    });

    test("leaves a plain block comment alone", () => {
      expect(typeShowingCursor("/* a *| */", "/")).toBe("/* a */| */");
    });

    test("does not edit a read-only editor", () => {
      editor.updateOptions({ readOnly: true });
      try {
        type("/** a *| */", "");
        const input = container.querySelector("textarea")!;
        const keydown = new KeyboardEvent("keydown", { key: "/", cancelable: true });
        input.dispatchEvent(keydown);
        expect(keydown.defaultPrevented).toBe(false);
      } finally {
        editor.updateOptions({ readOnly: false });
      }
    });

    test("ignores a `/` with modifiers", () => {
      type("/** a *| */", "");
      const input = container.querySelector("textarea")!;
      const keydown = new KeyboardEvent("keydown", { key: "/", metaKey: true, cancelable: true });
      input.dispatchEvent(keydown);
      expect(keydown.defaultPrevented).toBe(false);
      expect(editor.getModel()!.getValue()).toBe("/** a * */");
    });

    test("does not close a plain block comment", () => {
      expect(type("", "/*")).toBe("/*");
    });

    test("does not close single quotes, which start lifetimes", () => {
      expect(type("fn f<", "'")).toBe("fn f<'");
      expect(type("let c = ", "'")).toBe("let c = '");
      expect(type("fn f(x: &", "'a")).toBe("fn f(x: &'a");
    });

    test("closes backticks in doc comments and steps over the closing one", () => {
      expect(type("/// ", "`")).toBe("/// ``");
      expect(typeShowingCursor("/// ", "`Vec`")).toBe("/// `Vec`|");
    });

    test("keeps the built-in pairs", () => {
      expect(type("let x = ", "(")).toBe("let x = ()");
      expect(type("let x = ", "[")).toBe("let x = []");
      expect(type("let x = ", '"')).toBe('let x = ""');
    });
  });

  describe("surrounding a selection", () => {
    function surround(line: string, startColumn: number, endColumn: number, ch: string): string {
      type(line, "");
      editor.setSelection({ startLineNumber: 1, startColumn, endLineNumber: 1, endColumn });
      editor.trigger("keyboard", "type", { text: ch });
      return editor.getModel()!.getValue();
    }

    test.each([
      ["`", "/// `Vec`"],
      ["<", "/// <Vec>"],
      ['"', '/// "Vec"'],
    ])("with %s", (ch, after) => {
      expect(surround("/// Vec", 5, 8, ch)).toBe(after);
    });
  });

  describe("code indentation", () => {
    test.each([
      ["fn f() {", "fn f() {\n    |"],
      ["fn f() {|}", "fn f() {\n    |\n}"],
      ["match x {", "match x {\n    |"],
      ["let v = vec![", "let v = vec![\n    |"],
      ["foo(", "foo(\n    |"],
      ["    let x = 1;", "    let x = 1;\n    |"],
    ])("Enter after %p", (before, after) => {
      expect(typeShowingCursor(before, "\n")).toBe(after);
    });

    test("typing a closing brace outdents it", () => {
      expect(type("fn f() {\n    ", "}")).toBe("fn f() {\n}");
    });
  });

  test("folds `// region` markers", () => {
    const { start, end } = rustConfigurations.at(-1)?.folding?.markers ?? {};
    expect(start?.test("    // region: helpers")).toBe(true);
    expect(end?.test("    // endregion")).toBe(true);
    expect(start?.test("    // regional settings")).toBe(false);
    expect(start?.test("#pragma region")).toBe(false);
  });
});
