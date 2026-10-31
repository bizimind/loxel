import { type Mock, afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";

import * as monaco from "monaco-editor";

import { registerLanguageConfiguration } from "./c-language-config";

const LANGUAGES = ["c", "cpp", "objective-c"];

/** Internal model surface (not in monaco.d.ts) used to tokenize synchronously. */
interface InternalTextModel {
  tokenization: { forceTokenization(lineNumber: number): void };
}

describe("C-family editing in Monaco", () => {
  let container: HTMLElement;
  let editor: monaco.editor.IStandaloneCodeEditor;

  /** Every configuration registered per language, in order: Monaco's built-in one and ours. */
  const configurations = new Map<string, monaco.languages.LanguageConfiguration[]>();
  let setConfigurationSpy: Mock<typeof monaco.languages.setLanguageConfiguration>;

  beforeAll(async () => {
    const setConfiguration = monaco.languages.setLanguageConfiguration;
    setConfigurationSpy = spyOn(monaco.languages, "setLanguageConfiguration").mockImplementation(
      (id, configuration) => {
        configurations.set(id, [...(configurations.get(id) ?? []), configuration]);
        return setConfiguration(id, configuration);
      },
    );
    const registered = registerLanguageConfiguration();
    container = document.createElement("div");
    document.body.append(container);
    editor = monaco.editor.create(container, {
      // Headless DOM has no canvas.
      minimap: { enabled: false },
      overviewRulerLanes: 0,
    });
    const models = LANGUAGES.map((language) => monaco.editor.createModel("", language));
    await registered;
    for (const model of models) model.dispose();
  });

  afterAll(() => {
    setConfigurationSpy.mockRestore();
    const model = editor.getModel();
    editor.dispose();
    model?.dispose();
    container.remove();
  });

  // Each registration overrides the fields it sets, so a Monaco upgrade that registers its own
  // configuration later (or starts shipping these rules) has to fail here.
  test.each(LANGUAGES)("registers its %s configuration over Monaco's built-in one", (language) => {
    const registered = configurations.get(language);
    expect(registered).toHaveLength(2);
    const [builtin, ours] = registered ?? [];
    expect(builtin?.onEnterRules).toBeUndefined();
    expect(ours?.onEnterRules?.length).toBeGreaterThan(0);
    expect(ours?.comments).toEqual(builtin?.comments);
    expect(ours?.folding).toEqual(builtin?.folding);
  });

  /** Opens `content` in `language` with the cursor at the end of the last line. */
  function open(language: string, content: string): monaco.editor.ITextModel {
    editor.getModel()?.dispose();
    const model = monaco.editor.createModel(content, language);
    model.updateOptions({ tabSize: 4, insertSpaces: true });
    editor.setModel(model);
    const lastLine = model.getLineCount();
    // Rendering tokenizes visible lines; headless, Monaco misreads untokenized comment lines.
    (model as unknown as InternalTextModel).tokenization.forceTokenization(lastLine);
    editor.setPosition({ lineNumber: lastLine, column: model.getLineMaxColumn(lastLine) });
    return model;
  }

  function typeAtEnd(language: string, content: string, text: string): string {
    const model = open(language, content);
    for (const ch of text) editor.trigger("keyboard", "type", { text: ch });
    return model.getValue();
  }

  describe.each(LANGUAGES)("%s", (language) => {
    test("toggles a line comment", () => {
      const model = open(language, "int a = 1;");
      editor.trigger("keyboard", "editor.action.commentLine", null);
      expect(model.getValue()).toBe("// int a = 1;");
    });

    test("auto-closes a doc comment", () => {
      expect(typeAtEnd(language, "", "/**")).toBe("/** */");
    });

    test("continues a doc comment on Enter", () => {
      expect(typeAtEnd(language, "/**", "\n")).toBe("/**\n * ");
      expect(typeAtEnd(language, "/*!", "\n")).toBe("/*!\n * ");
    });

    test("continues the comment from its middle line", () => {
      expect(typeAtEnd(language, "/**\n * Doc.", "\n")).toBe("/**\n * Doc.\n * ");
      expect(typeAtEnd(language, "    /**\n     * Doc.", "\n")).toBe(
        "    /**\n     * Doc.\n     * ",
      );
    });

    test("leaves the comment on Enter after it closes", () => {
      expect(typeAtEnd(language, "/**\n * Doc.\n */", "\n")).toBe("/**\n * Doc.\n */\n");
    });

    test.each(["/* a */", "/** a */", "int *p;", "// a", "    *p = 1;"])(
      "does not continue after %p",
      (line) => {
        expect(typeAtEnd(language, line, "\n").split("\n")[1]?.trim()).toBe("");
      },
    );

    test.each([
      "int area = width\n     * height;",
      "    return aaaaa\n           * bbbbb;",
      "\t\tdouble v = a\n\t\t * b",
      "x = a\n *",
      "/* plain */\n * x",
    ])("does not continue the multiplication in %p", (code) => {
      const lines = typeAtEnd(language, code, "\n").split("\n");
      expect(lines.at(-1)?.trim()).toBe("");
    });

    test("keeps the built-in bracket pairs and indent", () => {
      expect(typeAtEnd(language, "int x = ", "(")).toBe("int x = ()");
      expect(typeAtEnd(language, "void f() {", "\n")).toBe("void f() {\n    ");
    });
  });
});
