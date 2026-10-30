import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";

import * as monaco from "monaco-editor";

import { BUILTIN_FILE_ASSOCIATIONS } from "@/store/settings-store";

import { registerLoxelLanguages } from "./monaco-languages";
import { toMonacoLanguage } from "./monaco-theme";

/** Languages Loxel registers, captured from the calls so other registrations don't count. */
const loxelLanguages: string[] = [];
/** Every configuration Loxel registers, by language. */
const configurations = new Map<string, monaco.languages.LanguageConfiguration>();

{
  const { register, setLanguageConfiguration } = monaco.languages;
  const registerSpy = spyOn(monaco.languages, "register").mockImplementation((language) => {
    loxelLanguages.push(language.id);
    return register(language);
  });
  const configurationSpy = spyOn(monaco.languages, "setLanguageConfiguration").mockImplementation(
    (id, configuration) => {
      configurations.set(id, configuration);
      return setLanguageConfiguration(id, configuration);
    },
  );
  registerLoxelLanguages();
  registerSpy.mockRestore();
  configurationSpy.mockRestore();
}

describe("registerLoxelLanguages", () => {
  test("registers every language a built-in file association resolves to", () => {
    const registered = new Set(monaco.languages.getLanguages().map(({ id }) => id));
    const resolved = new Set(BUILTIN_FILE_ASSOCIATIONS.map((a) => toMonacoLanguage(a.language)));
    // Monaco opens a model in an unregistered language as plaintext, with no grammar.
    expect([...resolved].filter((id) => !registered.has(id))).toEqual([]);
  });

  test("registers languages Monaco does not ship", () => {
    expect(loxelLanguages.toSorted()).toEqual([
      "astro",
      "dockerbake",
      "go.mod",
      "go.sum",
      "go.work",
      "groovy",
      "java-properties",
      "jsx",
      "just",
      "make",
      "pip-requirements",
      "terraform",
      "toml",
      "tsx",
    ]);
  });

  // Monaco only configures the languages it registers itself; Shiki's grammars only tokenize.
  // go.sum is generated and has neither comments nor brackets.
  const configured = loxelLanguages.filter((id) => id !== "go.sum");
  test.each(configured)("gives %s comments, brackets and auto-closing pairs", (id) => {
    const configuration = configurations.get(id);
    const { lineComment, blockComment } = configuration?.comments ?? {};
    expect(lineComment ?? blockComment).toBeDefined();
    expect(configuration?.brackets?.length).toBeGreaterThan(0);
    expect(configuration?.autoClosingPairs?.length).toBeGreaterThan(0);
  });
});

/** Internal model surface (not in monaco.d.ts) used to tokenize synchronously. */
interface InternalTextModel {
  tokenization: { forceTokenization(lineNumber: number): void };
}

describe("editing Loxel's languages in Monaco", () => {
  let container: HTMLElement;
  let editor: monaco.editor.IStandaloneCodeEditor;

  beforeAll(() => {
    container = document.createElement("div");
    document.body.append(container);
    editor = monaco.editor.create(container, {
      // Headless DOM has no canvas.
      minimap: { enabled: false },
      overviewRulerLanes: 0,
    });
  });

  afterAll(() => {
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
    // Rendering tokenizes visible lines; headless, Monaco skips auto-close on untokenized lines.
    (model as unknown as InternalTextModel).tokenization.forceTokenization(lastLine);
    editor.setPosition({ lineNumber: lastLine, column: model.getLineMaxColumn(lastLine) });
    return model;
  }

  function type(text: string): void {
    for (const ch of text) editor.trigger("keyboard", "type", { text: ch });
  }

  test.each([
    ["tsx", "const a = 1", "// const a = 1"],
    ["jsx", "const a = 1", "// const a = 1"],
    ["terraform", 'name = "a"', '# name = "a"'],
    ["make", "all: build", "# all: build"],
    ["just", "build:", "# build:"],
    ["groovy", "id 'java'", "// id 'java'"],
    ["java-properties", "org.gradle.caching=true", "# org.gradle.caching=true"],
    ["go.mod", "require a.b/c v1.0.0", "// require a.b/c v1.0.0"],
    ["go.work", "use ./a", "// use ./a"],
  ])("toggles a line comment in %s", (language, line, commented) => {
    const model = open(language, line);
    editor.trigger("keyboard", "editor.action.commentLine", null);
    expect(model.getValue()).toBe(commented);
  });

  test.each([
    "tsx",
    "jsx",
    "terraform",
    "make",
    "just",
    "go.mod",
    "go.work",
    "groovy",
    "java-properties",
  ])("auto-closes brackets in %s", (lang) => {
    const model = open(lang, "x = ");
    type("(");
    expect(model.getValue()).toBe("x = ()");
  });

  test.each(['"""', "'''"])("auto-closes %s in Groovy", (quotes) => {
    const model = open("groovy", "def a = ");
    type(quotes);
    expect(model.getValue()).toBe(`def a = ${quotes}${quotes}`);
    expect(editor.getPosition()?.column).toBe("def a = ".length + quotes.length + 1);
  });

  test("leaves go.sum alone on toggle line comment", () => {
    const line = "a.b/c v1.0.0 h1:abc=";
    const model = open("go.sum", line);
    editor.trigger("keyboard", "editor.action.commentLine", null);
    expect(model.getValue()).toBe(line);
  });

  test.each(["go.mod", "go.work"])("indents a block on Enter in %s", (language) => {
    const model = open(language, "require ");
    type("(");
    type("\n");
    expect(model.getLineContent(2).trim()).toBe("");
    expect(model.getLineContent(2).length).toBeGreaterThan(0);
    expect(model.getLineContent(3)).toBe(")");
  });

  test("continues a JSDoc comment on Enter in TSX", () => {
    const model = open("tsx", "/**");
    type("\n");
    expect(model.getLineContent(2)).toBe(" * ");
  });
});
