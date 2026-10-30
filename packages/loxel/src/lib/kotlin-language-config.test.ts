import { type Mock, afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";

import { shikiToMonaco } from "@shikijs/monaco";
import * as monaco from "monaco-editor";

import { getHighlighter } from "./highlighter";
import { registerLanguageConfiguration } from "./kotlin-language-config";
import { registerLanguageConfiguration as registerPythonLanguageConfiguration } from "./python-language-config";
import { resolveLanguage } from "./resolve-language";

/** Internal model surface (not in monaco.d.ts) used to tokenize synchronously. */
interface InternalTextModel {
  tokenization: { forceTokenization(lineNumber: number): void };
}

/** Loading Monaco and Shiki's grammars is slow on a busy machine; Bun's default is 5 seconds. */
const BEFORE_ALL_TIMEOUT_MS = 120_000;

describe("Kotlin editing in Monaco", () => {
  let container: HTMLElement;
  let editor: monaco.editor.IStandaloneCodeEditor;

  /** Every Kotlin configuration registered, in order: Monaco's built-in one and ours. */
  const kotlinConfigurations: monaco.languages.LanguageConfiguration[] = [];
  let setConfigurationSpy: Mock<typeof monaco.languages.setLanguageConfiguration>;

  beforeAll(async () => {
    const setConfiguration = monaco.languages.setLanguageConfiguration;
    setConfigurationSpy = spyOn(monaco.languages, "setLanguageConfiguration").mockImplementation(
      (id, configuration) => {
        if (id === "kotlin") kotlinConfigurations.push(configuration);
        return setConfiguration(id, configuration);
      },
    );
    const registered = registerLanguageConfiguration();
    // Owns the triple-quote step-over hook; it never resolves here since no Python model appears.
    void registerPythonLanguageConfiguration();
    // The app tokenizes with Shiki rather than Monarch, and `notIn` reads the resulting token types.
    shikiToMonaco(await getHighlighter(), monaco);
    container = document.createElement("div");
    document.body.append(container);
    const model = monaco.editor.createModel("", "kotlin");
    editor = monaco.editor.create(container, {
      model,
      insertSpaces: true,
      tabSize: 4,
      // Headless DOM has no canvas.
      minimap: { enabled: false },
      overviewRulerLanes: 0,
    });
    await registered;
  }, BEFORE_ALL_TIMEOUT_MS);

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
    expect(kotlinConfigurations).toHaveLength(2);
    const [builtin, ours] = kotlinConfigurations;
    expect(builtin?.autoClosingPairs?.some((p) => p.open === '"""')).toBe(false);
    expect(ours?.autoClosingPairs?.some((p) => p.open === '"""')).toBe(true);
    expect(ours?.comments).toEqual(builtin?.comments);
    expect(ours?.folding).toEqual(builtin?.folding);
  });

  test.each(["Main.kt", "build.kts"])("%s opens as Kotlin", (name) => {
    expect(resolveLanguage(name, [])).toBe("kotlin");
    const model = monaco.editor.createModel("", undefined, monaco.Uri.file(`/${name}`));
    expect(model.getLanguageId()).toBe("kotlin");
    model.dispose();
  });

  /**
   * Sets the content and cursor (a single `|`, or else the end), then types through the textarea
   * keydown. Returns the content, with `|` marking the resulting cursor.
   */
  function type(initial: string, text: string): string {
    const model = editor.getModel()!;
    const marker = initial.indexOf("|");
    model.setValue(marker === -1 ? initial : initial.slice(0, marker) + initial.slice(marker + 1));
    // Rendering tokenizes visible lines; headless, Monaco skips auto-close on untokenized lines.
    const { tokenization } = model as unknown as InternalTextModel;
    for (let line = 1; line <= model.getLineCount(); line++) tokenization.forceTokenization(line);
    editor.setPosition(
      marker === -1 ? model.getPositionAt(model.getValueLength()) : model.getPositionAt(marker),
    );
    const input = container.querySelector("textarea")!;
    for (const ch of text) {
      const keydown = new KeyboardEvent("keydown", { key: ch, cancelable: true });
      input.dispatchEvent(keydown);
      if (!keydown.defaultPrevented) editor.trigger("keyboard", "type", { text: ch });
    }
    const offset = model.getOffsetAt(editor.getPosition()!);
    const value = model.getValue();
    return `${value.slice(0, offset)}|${value.slice(offset)}`;
  }

  test.each([
    // Raw strings
    ["val x = ", `"""`, `val x = """|"""`],
    ["val x = ", `"""abc"""`, `val x = """abc"""|`],
    [`val x = """\n    a\n"|""`, `""`, `val x = """\n    a\n"""|`],
    ["// ", `"""`, `// """|`],
    ["/** ", `"""`, `/** """|`],
    // Strings and characters
    ["val x = ", `"abc"`, `val x = "abc"|`],
    [`val x = "a `, `"`, `val x = "a "|`],
    [`val x = "a `, `\${b}"`, `val x = "a \${b}"|`],
    ["val x = ", "'a'", "val x = 'a'|"],
    ["val x = ", `'"'`, `val x = '"'|`],
    [`val x = "a `, "'", `val x = "a '|`],
    ["// a ", "'", "// a '|"],
    // Templates
    [`val x = "a $|"`, "{", `val x = "a \${|}"`],
    [`val x = """a $|"""`, "{", `val x = """a \${|}"""`],
    // Backticks
    ["fun ", "`", "fun `|`"],
    ["fun ", "`my test`", "fun `my test`|"],
    ["/** see ", "`", "/** see `|`"],
    [`val x = "a `, "`", `val x = "a \`|`],
    // Generics stay unpaired, since `<` is just as often a comparison.
    ["val x: List", "<Int>", "val x: List<Int>|"],
  ])("%p typing %p gives %p", (initial, text, expected) => {
    expect(type(initial, text)).toBe(expected);
  });

  test.each([
    // KDoc
    ["", "/**", "/**| */"],
    [`val x = "`, "/**", `val x = "/**|`],
    ["", "/**\n", "/**\n * |\n */"],
    ["class A {\n    ", "/**\n", "class A {\n    /**\n     * |\n     */"],
    ["/**|", "\n", "/**\n * |"],
    ["/**| */", "\n", "/**\n * |\n */"],
    ["/**\n * abc", "\n", "/**\n * abc\n * |"],
    ["/**\n * abc\n */", "\n", "/**\n * abc\n */\n|"],
    [
      "class A {\n    /**\n     * abc\n     */",
      "\n",
      "class A {\n    /**\n     * abc\n     */\n    |",
    ],
    ["/**\n *", "\n", "/**\n *\n * |"],
    ["/**\n * abc */", "\n", "/**\n * abc */\n|"],
    ["/** abc */", "\n", "/** abc */\n|"],
    ["/**/", "\n", "/**/\n|"],
    // A leading `*` operator at an even indent is not a comment line.
    ["    val y = 2\n    * 3", "\n", "    val y = 2\n    * 3\n    |"],
    // Brackets
    ["fun f() {|}", "\n", "fun f() {\n    |\n}"],
    ["foo(|)", "\n", "foo(\n    |\n)"],
    ["if (x) {", "\n", "if (x) {\n    |"],
    // Lambdas
    ["list.map { x ->|}", "\n", "list.map { x ->\n    |\n}"],
    ["list.map { (a, b): Pair<Int, Int> ->", "\n", "list.map { (a, b): Pair<Int, Int> ->\n    |"],
    ["list.map { x -> x + 1 }", "\n", "list.map { x -> x + 1 }\n|"],
    ["list.map { x -> ", "\n", "list.map { x -> \n    |"],
    ["x.let { it } ->", "\n", "x.let { it } ->\n|"],
    // Only lambdas: `when` branches and function types keep the current indent.
    ["    1 ->", "\n", "    1 ->\n    |"],
    ["val f: (Int) ->", "\n", "val f: (Int) ->\n|"],
  ])("%p Enter via %p gives %p", (initial, text, expected) => {
    expect(type(initial, text)).toBe(expected);
  });

  test.each([
    ["`", "foo `bar`"],
    ['"', 'foo "bar"'],
    ["<", "foo <bar>"],
  ])("surrounds a selection with %s", (ch, expected) => {
    const model = editor.getModel()!;
    type("foo bar", "");
    editor.setSelection(new monaco.Selection(1, 5, 1, 8));
    editor.trigger("keyboard", "type", { text: ch });
    expect(model.getValue()).toBe(expected);
  });

  test.each([
    ["editor.action.commentLine", "// val x = 1"],
    ["editor.action.blockComment", "/* val x = 1 */"],
  ])("%s toggles comments", async (action, commented) => {
    const model = editor.getModel()!;
    type("val x = 1", "");
    editor.setSelection(new monaco.Selection(1, 1, 1, 10));
    await editor.getAction(action)?.run();
    expect(model.getValue()).toBe(commented);
    await editor.getAction(action)?.run();
    expect(model.getValue()).toBe("val x = 1");
  });
});
