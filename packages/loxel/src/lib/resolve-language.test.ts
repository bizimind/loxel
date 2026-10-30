import { describe, expect, test } from "bun:test";

import { BUILTIN_FILE_ASSOCIATIONS } from "@/store/settings-store";

import { toMonacoLanguage } from "./monaco-theme";
import { resolveLanguage } from "./resolve-language";

function resolve(path: string, content?: string): string | null {
  return resolveLanguage(path, BUILTIN_FILE_ASSOCIATIONS, content);
}

describe("resolveLanguage for Python projects", () => {
  test.each([
    ["/repo/app.py", "python"],
    ["/repo/stubs/module.pyi", "python"],
    ["/repo/gui.pyw", "python"],
    ["/repo/pyproject.toml", "toml"],
    ["/repo/ruff.toml", "toml"],
    ["/repo/uv.lock", "toml"],
    ["/repo/poetry.lock", "toml"],
    ["/repo/Pipfile", "toml"],
    ["/repo/Pipfile.lock", "json"],
    ["/repo/requirements.txt", "pip-requirements"],
    ["/repo/requirements-dev.txt", "pip-requirements"],
    ["/repo/requirements.in", "pip-requirements"],
    ["/repo/requirements/base.txt", "pip-requirements"],
    ["/repo/constraints.txt", "pip-requirements"],
  ])("%s → %s", (path, language) => {
    expect(resolve(path)).toBe(language);
  });

  test("matches directory globs under dot directories", () => {
    expect(resolve("/home/me/repo/.worktrees/fix/x/requirements/dev.txt")).toBe("pip-requirements");
    expect(resolve("/repo/.vscode/settings.json")).toBe("jsonc");
  });

  test("leaves other text files alone", () => {
    expect(resolve("/repo/notes.txt")).toBeNull();
  });

  test("sniffs extensionless Python scripts by shebang", () => {
    expect(resolve("/repo/bin/manage", "#!/usr/bin/env python3\nprint(1)\n")).toBe("python");
  });
});

describe("resolveLanguage for build files", () => {
  test.each([
    ["/repo/Makefile", "make"],
    ["/repo/makefile", "make"],
    ["/repo/GNUmakefile", "make"],
    ["/repo/build/rules.mk", "make"],
    ["/repo/justfile", "just"],
    ["/repo/.justfile", "just"],
    ["/repo/tasks.just", "just"],
  ])("%s → %s", (path, language) => {
    expect(resolve(path)).toBe(language);
  });
});

describe("toMonacoLanguage", () => {
  test("keeps TOML as its own Monaco language so it gets the TOML grammar", () => {
    expect(toMonacoLanguage("toml")).toBe("toml");
  });

  test("passes custom languages through", () => {
    expect(toMonacoLanguage("pip-requirements")).toBe("pip-requirements");
  });
});

describe("resolveLanguage for Gradle and Maven projects", () => {
  test.each([
    ["/repo/build.gradle", "groovy"],
    ["/repo/settings.gradle", "groovy"],
    ["/repo/gradle/libs.gradle", "groovy"],
    ["/repo/src/Util.groovy", "groovy"],
    ["/repo/Jenkinsfile", "groovy"],
    ["/repo/build.gradle.kts", "kotlin"],
    ["/repo/gradle.properties", "java-properties"],
    ["/repo/gradle/wrapper/gradle-wrapper.properties", "java-properties"],
    ["/repo/src/main/resources/messages_de.properties", "java-properties"],
    ["/repo/gradlew", "bash"],
    ["/repo/mvnw", "bash"],
    ["/repo/gradlew.bat", "bat"],
    ["/repo/mvnw.cmd", "bat"],
  ])("%s → %s", (path, language) => {
    expect(resolve(path)).toBe(language);
  });

  test.each([
    ["/repo/build.gradle", "groovy"],
    ["/repo/gradle.properties", "java-properties"],
    ["/repo/gradlew", "shell"],
    ["/repo/gradlew.bat", "bat"],
  ])("%s opens in Monaco as %s", (path, monacoLanguage) => {
    expect(toMonacoLanguage(resolve(path))).toBe(monacoLanguage);
  });

  test("leaves other batch files alone", () => {
    expect(resolve("/repo/run.bat")).toBeNull();
  });
});
