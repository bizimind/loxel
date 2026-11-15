import { expect, test } from "bun:test";

// `monaco-env.ts` finds these with `import.meta.glob`, which only Vite resolves.
const modules = [...new Bun.Glob("*-language-config.ts").scanSync(import.meta.dir)];

// Loaded up front: importing Monaco takes long enough to run into a test's timeout.
const loaded = await Promise.all(
  modules.map(async (file): Promise<[string, unknown]> => [file, await import(`./${file}`)]),
);

test("finds the language config modules", () => {
  expect(modules).toContain("python-language-config.ts");
});

test.each(loaded)("%s exports registerLanguageConfiguration", (_file, languageConfig) => {
  expect(languageConfig).toHaveProperty("registerLanguageConfiguration", expect.any(Function));
});
