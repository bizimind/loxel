import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import * as monaco from "monaco-editor";

import {
  PYTHON_DEDENT_AFTER,
  isInsideTripleQuote,
  registerPythonLanguageConfiguration,
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
  ])("does not dedent after %p", (line) => {
    expect(PYTHON_DEDENT_AFTER.test(line)).toBe(false);
  });
});

/** `|` marks the cursor. */
function insideTripleQuote(marked: string, quote: string): boolean {
  return isInsideTripleQuote(marked.replace("|", ""), marked.indexOf("|") + 1, quote);
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

  beforeAll(async () => {
    registerPythonLanguageConfiguration();
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
    // Monaco's built-in config loads asynchronously; ours is registered a task after it.
    await Bun.sleep(50);
  });

  afterAll(() => {
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

  test("does not auto-close triple quotes in comments", () => {
    expect(typeAtEnd("# ", `"""`)).toBe(`# """`);
  });

  test("keeps the built-in pairs", () => {
    expect(typeAtEnd("x = ", "(")).toBe("x = ()");
    expect(typeAtEnd("x = ", `"`)).toBe(`x = ""`);
  });
});
