import { expect, test } from "bun:test";

import { BUILTIN_FILE_ASSOCIATIONS } from "@/store/settings-store";

import { resolveLanguage } from "./resolve-language";

test("only Java files get the Java language, which starts the Java server", () => {
  expect(resolveLanguage("/repo/App.java", BUILTIN_FILE_ASSOCIATIONS)).toBe("java");
  expect(resolveLanguage("/repo/App.scala", BUILTIN_FILE_ASSOCIATIONS)).toBe("scala");
});
