import { describe, expect, test } from "bun:test";

import { getFileIconPath, getFolderIconPath } from "./file-icons";

describe("Go project icons", () => {
  test.each([
    ["main.go", "go_dark.svg"],
    ["go.mod", "goMod_dark.svg"],
    ["go.sum", "goSum_dark.svg"],
    ["go.work", "goWork_dark.svg"],
    ["go.work.sum", "goSum_dark.svg"],
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
