import { describe, expect, test } from "bun:test";

import { toTombiPatterns } from "@/server/toml-lsp-manager";
import { BUILTIN_FILE_ASSOCIATIONS } from "@/store/settings-store";

import { getFileIconPath } from "./file-icons";
import { resolveLanguage } from "./resolve-language";
import { classifySchemaGlob } from "./schema-glob";

function resolve(path: string, content?: string): string | null {
  return resolveLanguage(path, BUILTIN_FILE_ASSOCIATIONS, content);
}

describe("resolveLanguage for Rust projects", () => {
  test.each([
    ["/repo/src/main.rs", "rust"],
    ["/repo/Cargo.toml", "toml"],
    ["/repo/Cargo.lock", "toml"],
    ["/repo/.cargo/config.toml", "toml"],
    ["/repo/.cargo/config", "toml"],
    ["/home/me/.cargo/config", "toml"],
    ["/repo/rust-toolchain.toml", "toml"],
    ["/repo/clippy.toml", "toml"],
    ["/repo/.clippy.toml", "toml"],
    ["/repo/rustfmt.toml", "toml"],
    ["/repo/.rustfmt.toml", "toml"],
  ])("%s → %s", (path, language) => {
    expect(resolve(path)).toBe(language);
  });

  test("leaves other files named config alone", () => {
    expect(resolve("/repo/config")).toBeNull();
    expect(resolve("/repo/.git/config")).toBeNull();
  });

  // Its legacy format is a bare channel name, which is not TOML.
  test("leaves the extensionless rust-toolchain as plain text", () => {
    expect(resolve("/repo/rust-toolchain", "nightly-2024-01-01\n")).toBeNull();
    expect(resolve("/repo/rust-toolchain", '[toolchain]\nchannel = "stable"\n')).toBeNull();
  });
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

describe("rust-toolchain.toml schema", () => {
  test("stays away from JSON and YAML", () => {
    expect(classifySchemaGlob("**/rust-toolchain.toml")).toEqual({
      json: false,
      yaml: false,
      toml: true,
    });
  });

  test("matches at any depth in Tombi", () => {
    expect(toTombiPatterns("**/rust-toolchain.toml", "/wt")).toEqual(["**/rust-toolchain.toml"]);
  });
});
