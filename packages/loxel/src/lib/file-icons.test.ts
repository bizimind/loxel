import { describe, expect, test } from "bun:test";

import { getFileIconPath, getFolderIconPath } from "./file-icons";

describe("Java project icons", () => {
  test.each([
    ["App.java", "java_dark.svg"],
    ["module-info.java", "module_dark.svg"],
    ["lib.jar", "archive_dark.svg"],
    ["app.war", "archive_dark.svg"],
    ["app.ear", "archive_dark.svg"],
    [".java-version", "java_dark.svg"],
    [".sdkmanrc", "java_dark.svg"],
  ])("%s → %s", (filename, icon) => {
    expect(getFileIconPath(filename)).toBe(`./icons/${icon}`);
  });
});

describe("Python project icons", () => {
  test.each([
    ["app.py", "python.svg"],
    ["module.pyi", "python.svg"],
    ["pyproject.toml", "python.svg"],
    ["Pipfile", "python.svg"],
    [".python-version", "python.svg"],
    ["requirements.txt", "python.svg"],
    ["requirements-dev.in", "python.svg"],
    ["constraints.txt", "python.svg"],
    ["uv.lock", "lock_dark.svg"],
    ["ruff.toml", "toml_dark.svg"],
    ["notes.txt", "text_dark.svg"],
  ])("%s → %s", (filename, icon) => {
    expect(getFileIconPath(filename)).toBe(`./icons/${icon}`);
  });

  test.each([".venv", "venv", "__pycache__", ".pytest_cache", "pkg/__pycache__"])(
    "%s folder is shown as excluded",
    (folder) => {
      expect(getFolderIconPath(folder)).toBe("./icons/folderExcluded_dark.svg");
    },
  );
});
