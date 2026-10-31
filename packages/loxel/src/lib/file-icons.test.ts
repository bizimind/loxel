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

describe("C-family project icons", () => {
  test.each([
    ["lib.c", "c_dark.svg"],
    ["lib.i", "c_dark.svg"],
    ["View.m", "c_dark.svg"],
    ["app.C", "cpp_dark.svg"],
    ["app.c++", "cpp_dark.svg"],
    ["app.ii", "cpp_dark.svg"],
    ["Bridge.mm", "cpp_dark.svg"],
    ["a.h++", "h_dark.svg"],
    ["a.inl", "h_dark.svg"],
    ["a.ipp", "h_dark.svg"],
    ["a.tpp", "h_dark.svg"],
    ["a.tcc", "h_dark.svg"],
    ["a.txx", "h_dark.svg"],
    ["makefile", "makefile_dark.svg"],
    ["CMakePresets.json", "CMake_dark.svg"],
    ["CMakeUserPresets.json", "CMake_dark.svg"],
    [".clangd", "config_dark.svg"],
    [".clang-format", "config_dark.svg"],
    ["_clang-format", "config_dark.svg"],
    [".clang-tidy", "config_dark.svg"],
    [".clang-format-ignore", "ignored_dark.svg"],
    ["compile_commands.json", "config_dark.svg"],
    ["compile_flags.txt", "config_dark.svg"],
    ["vcpkg.json", "config_dark.svg"],
  ])("%s → %s", (filename, icon) => {
    expect(getFileIconPath(filename)).toBe(`./icons/${icon}`);
  });
});

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
