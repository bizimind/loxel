import { type Mock, afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";

import * as monaco from "monaco-editor";

import {
  PYTHON_DEDENT_AFTER,
  isInsideTripleQuote,
  registerLanguageConfiguration,
} from "./python-language-config";

describe("PYTHON_DEDENT_AFTER", () => {
  test.each([
    "    return",
    "    return x",
    "        return foo(x)",
    "    pass",
    "    pass  # done",
    "    break",
    "    continue",
    "    raise",
    "    raise ValueError('bad')",
    "    return x  # see a, b,",
    "    return -1",
  ])("dedents after %p", (line) => {
    expect(PYTHON_DEDENT_AFTER.test(line)).toBe(true);
  });

  test.each([
    "return x", // already at column 0
    "    return_value = 1",
    "    passenger = 1",
    "    breakpoint()",
    "    return foo(",
    "    return [",
    "    return a, \\",
    "    raise ValueError(  # explain",
    "    return (a +",
    "    return a and \\",
    '    return """',
  ])("does not dedent after %p", (line) => {
    expect(PYTHON_DEDENT_AFTER.test(line)).toBe(false);
  });
});

/** A single `|` marks the cursor. */
function insideTripleQuote(marked: string, quote: string): boolean {
  const cursor = marked.indexOf("|");
  const line = marked.slice(0, cursor) + marked.slice(cursor + 1);
  return isInsideTripleQuote(line, cursor + 1, quote);
}

describe("isInsideTripleQuote", () => {
  test.each([
    [`"""a"|""`, `"`],
    [`"""a""|"`, `"`],
    [`x = ''|'`, `'`],
  ])("%p", (marked, quote) => {
    expect(insideTripleQuote(marked, quote)).toBe(true);
  });

  test.each([
    [`"""a|"""`, `"`], // at the edge of the run, not inside
    [`""|`, `"`],
    [`"|"`, `"`],
    [`""|""`, `"`],
    [`""""|""`, `"`],
    [`"""a"|""`, `'`],
  ])("not %p", (marked, quote) => {
    expect(insideTripleQuote(marked, quote)).toBe(false);
  });
});

/** Internal model surface (not in monaco.d.ts) used to tokenize synchronously. */
interface InternalTextModel {
  tokenization: { forceTokenization(lineNumber: number): void };
}

describe("Python editing in Monaco", () => {
  let container: HTMLElement;
  let editor: monaco.editor.IStandaloneCodeEditor;

  /** Every Python configuration registered, in order: Monaco's built-in one and ours. */
  const pythonConfigurations: monaco.languages.LanguageConfiguration[] = [];
  let setConfigurationSpy: Mock<typeof monaco.languages.setLanguageConfiguration>;

  beforeAll(async () => {
    const setConfiguration = monaco.languages.setLanguageConfiguration;
    setConfigurationSpy = spyOn(monaco.languages, "setLanguageConfiguration").mockImplementation(
      (id, configuration) => {
        if (id === "python") pythonConfigurations.push(configuration);
        return setConfiguration(id, configuration);
      },
    );
    const registered = registerLanguageConfiguration();
    monaco.languages.register({ id: "toml" }); // registered by monaco-languages.ts in the app
    container = document.createElement("div");
    document.body.append(container);
    const model = monaco.editor.createModel("", "python");
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

  // Each registration overrides the fields it sets, so a Monaco upgrade that registers its own
  // configuration later (or no longer exposes it) would silently drop ours.
  test("registers its configuration last, over Monaco's built-in one", () => {
    expect(pythonConfigurations).toHaveLength(2);
    const [builtin, ours] = pythonConfigurations;
    expect(builtin?.autoClosingPairs?.some((p) => p.open === '"""')).toBe(false);
    expect(ours?.autoClosingPairs?.some((p) => p.open === '"""')).toBe(true);
    expect(ours?.onEnterRules?.at(-1)?.beforeText).toBe(PYTHON_DEDENT_AFTER);
    expect(ours?.indentationRules).toEqual(builtin?.indentationRules);
  });

  afterAll(() => {
    setConfigurationSpy.mockRestore();
    const model = editor.getModel();
    editor.dispose();
    model?.dispose();
    container.remove();
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

  test("keeps the built-in indent after a block opener", () => {
    expect(typeAtEnd("def f():", "\n")).toBe("def f():\n    ");
  });

  test("dedents after return", () => {
    expect(typeAtEnd("def f():\n    return 1", "\n")).toBe("def f():\n    return 1\n");
  });

  test("keeps the indent when Enter splits a return statement", () => {
    const model = editor.getModel()!;
    typeAtEnd("def f():\n    return some(a, b) + other(c)", "");
    editor.setPosition({ lineNumber: 2, column: 23 }); // before `+`
    editor.trigger("keyboard", "type", { text: "\n" });
    expect(model.getLineContent(3)).toBe("    + other(c)");
  });

  test("auto-closes triple-quoted docstrings", () => {
    expect(typeAtEnd("def f():\n    ", `"""`)).toBe(`def f():\n    """"""`);
    expect(typeAtEnd("x = ", `'''`)).toBe(`x = ''''''`);
  });

  test("types over the whole closing triple quote", () => {
    expect(typeAtEnd("def f():\n    ", `"""Doc."""`)).toBe(`def f():\n    """Doc."""`);
    expect(editor.getPosition()?.column).toBe(15);
  });

  test("types over the rest of a closing triple quote it did not insert", () => {
    const model = editor.getModel()!;
    typeAtEnd(`x = '''Doc.'''`, "");
    editor.setPosition({ lineNumber: 1, column: 13 }); // after the first closing quote
    const input = container.querySelector("textarea")!;
    for (let i = 0; i < 2; i++) {
      const keydown = new KeyboardEvent("keydown", { key: "'", cancelable: true });
      input.dispatchEvent(keydown);
      expect(keydown.defaultPrevented).toBe(true);
    }
    expect(model.getValue()).toBe(`x = '''Doc.'''`);
    expect(editor.getPosition()?.column).toBe(15);
  });

  test("ignores quote keys with modifiers", () => {
    const model = editor.getModel()!;
    typeAtEnd(`x = """a"""`, "");
    editor.setPosition({ lineNumber: 1, column: 10 });
    const input = container.querySelector("textarea")!;
    const keydown = new KeyboardEvent("keydown", { key: '"', metaKey: true, cancelable: true });
    input.dispatchEvent(keydown);
    expect(keydown.defaultPrevented).toBe(false);
    expect(model.getValue()).toBe(`x = """a"""`);
  });

  test("steps over triple quotes in TOML too", () => {
    const model = editor.getModel()!;
    monaco.editor.setModelLanguage(model, "toml");
    try {
      typeAtEnd(`x = """a"""`, "");
      editor.setPosition({ lineNumber: 1, column: 10 });
      const input = container.querySelector("textarea")!;
      const keydown = new KeyboardEvent("keydown", { key: '"', cancelable: true });
      input.dispatchEvent(keydown);
      expect(keydown.defaultPrevented).toBe(true);
      expect(editor.getPosition()?.column).toBe(11);
    } finally {
      monaco.editor.setModelLanguage(model, "python");
    }
  });

  test("does not auto-close triple quotes in comments", () => {
    expect(typeAtEnd("# ", `"""`)).toBe(`# """`);
  });

  test("keeps the built-in pairs", () => {
    expect(typeAtEnd("x = ", "(")).toBe("x = ()");
    expect(typeAtEnd("x = ", `"`)).toBe(`x = ""`);
  });
});
