import { describe, expect, test } from "bun:test";

import { getFileIconPath, getFolderIconPath } from "./file-icons";

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

describe("Rust project icons", () => {
  test.each([
    ["main.rs", "rustFile_dark.svg"],
    ["Cargo.toml", "cargo_dark.svg"],
    ["Cargo.lock", "cargoLock_dark.svg"],
    ["rust-toolchain.toml", "cargo_dark.svg"],
    ["rust-toolchain", "cargo_dark.svg"],
    ["clippy.toml", "rustFile_dark.svg"],
    [".clippy.toml", "rustFile_dark.svg"],
    ["rustfmt.toml", "rustFile_dark.svg"],
    [".rustfmt.toml", "rustFile_dark.svg"],
  ])("%s → %s", (filename, icon) => {
    expect(getFileIconPath(filename)).toBe(`./icons/${icon}`);
  });
});
