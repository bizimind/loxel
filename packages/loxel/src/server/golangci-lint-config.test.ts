import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { findGolangciConfig, judgeGolangciConfig } from "./golangci-lint-config";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "golangci-config-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function judge(name: string, text: string) {
  const file = join(dir, name);
  await writeFile(file, text);
  return judgeGolangciConfig(file);
}

const CUSTOM_ENTRY = "mine: {path: ./mine.so}";

describe("judgeGolangciConfig", () => {
  test("runs a plain v2 config in any format", async () => {
    const yaml = `version: "2"\nlinters:\n  enable: [govet]\n  settings:\n    govet: {enable-all: true}\n`;
    expect(await judge(".golangci.yml", yaml)).toBe("runnable");
    expect(await judge(".golangci.yaml", "version: 2\n")).toBe("runnable");
    expect(await judge(".golangci.toml", 'version = "2"\n[linters]\nenable = ["govet"]\n')).toBe(
      "runnable",
    );
    expect(await judge(".golangci.json", '{"version":"2"}')).toBe("runnable");
  });

  test("allows the standard streams as output", async () => {
    const text = `version: "2"\noutput:\n  formats:\n    text: {path: stdout}\n    json: {path: stderr}\n`;
    expect(await judge(".golangci.yml", text)).toBe("runnable");
  });

  test("calls a config without version 2 a v1 config", async () => {
    expect(await judge(".golangci.yml", "linters:\n  enable: [govet]\n")).toBe("v1");
    expect(await judge(".golangci.yml", 'version: "1"\n')).toBe("v1");
  });

  test.each([
    ["nested", `version: "2"\nlinters:\n  settings:\n    custom:\n      ${CUSTOM_ENTRY}\n`],
    ["empty", `version: "2"\nlinters:\n  settings:\n    custom: {}\n`],
    ["uppercase", `version: "2"\nLINTERS:\n  Settings:\n    CUSTOM:\n      ${CUSTOM_ENTRY}\n`],
    ["dotted", `version: "2"\nlinters.settings.custom:\n  ${CUSTOM_ENTRY}\n`],
    ["fully dotted", `version: "2"\nlinters.settings.custom.mine.path: ./mine.so\n`],
    ["partly dotted", `version: "2"\nlinters:\n  settings.custom:\n    ${CUSTOM_ENTRY}\n`],
    ["long s", `version: "2"\nlinters:\n  ſettings:\n    cuſtom:\n      ${CUSTOM_ENTRY}\n`],
    [
      "dotted capital I",
      `version: "2"\nLİNTERS:\n  settİngs:\n    custom:\n      ${CUSTOM_ENTRY}\n`,
    ],
    [
      "merge",
      `version: "2"\nx: &x\n  custom:\n    ${CUSTOM_ENTRY}\nlinters:\n  settings:\n    <<: *x\n`,
    ],
    [
      "merged list",
      `version: "2"\nx: &x\n  custom:\n    ${CUSTOM_ENTRY}\ny: &y {}\nlinters:\n  settings:\n    <<: [*y, *x]\n`,
    ],
    ["complex key", `version: "2"\nlinters:\n  settings:\n    ? custom\n    : ${CUSTOM_ENTRY}\n`],
    ["old section", `version: "2"\nlinters-settings:\n  custom:\n    ${CUSTOM_ENTRY}\n`],
    ["no version", `linters:\n  settings:\n    custom:\n      ${CUSTOM_ENTRY}\n`],
  ])("refuses custom linters in YAML: %s", async (_, text) => {
    expect(await judge(".golangci.yml", text)).toBe("custom");
  });

  test("refuses custom linters in TOML and JSON", async () => {
    const tables = 'version = "2"\n[linters.settings.custom.mine]\npath = "./mine.so"\n';
    expect(await judge(".golangci.toml", tables)).toBe("custom");
    const quoted = 'version = "2"\n"linters.settings.custom".mine.path = "./mine.so"\n';
    expect(await judge(".golangci.toml", quoted)).toBe("custom");
    const nested = {
      version: "2",
      linters: { settings: { custom: { mine: { path: "./mine.so" } } } },
    };
    expect(await judge(".golangci.json", JSON.stringify(nested))).toBe("custom");
    const dotted = { version: "2", "Linters.Settings.Custom": { mine: { path: "./mine.so" } } };
    expect(await judge(".golangci.json", JSON.stringify(dotted))).toBe("custom");
  });

  test("refuses an output file, however it is spelled", async () => {
    expect(
      await judge(".golangci.yml", `version: "2"\noutput:\n  formats:\n    text: {path: /tmp/x}\n`),
    ).toBe("custom");
    expect(await judge(".golangci.yml", `version: "2"\noutput.formats.json.path: x.json\n`)).toBe(
      "custom",
    );
    expect(
      await judge(".golangci.yml", `version: "2"\nOUTPUT:\n  Formats:\n    Sarif: {PATH: x}\n`),
    ).toBe("custom");
    expect(
      await judge(".golangci.toml", 'version = "2"\n[output.formats.text]\npath = "x"\n'),
    ).toBe("custom");
    expect(
      await judge(".golangci.json", '{"version":"2","output":{"formats":{"text":{"path":""}}}}'),
    ).toBe("custom");
  });

  test("cannot read broken, multi-document, oversized or self-containing configs", async () => {
    expect(await judge(".golangci.yml", "version: [")).toBe("unreadable");
    expect(await judge(".golangci.yml", 'version: "2"\n---\nlinters: {}\n')).toBe("unreadable");
    expect(await judge(".golangci.json", "{")).toBe("unreadable");
    expect(await judge(".golangci.toml", "= nope")).toBe("unreadable");
    expect(await judge(".golangci.yml", `version: "2"\n# ${"x".repeat(1024 * 1024)}\n`)).toBe(
      "unreadable",
    );
    expect(await judge(".golangci.yml", 'version: "2"\na: &a\n  b: *a\n')).toBe("unreadable");
    expect(judgeGolangciConfig(join(dir, "missing.yml"))).toBe("unreadable");
  });
});

describe("judgeGolangciConfig on YAML its parser could read differently", () => {
  const LINTERS = `linters: {settings: {custom: {${CUSTOM_ENTRY}}}}`;
  test.each([
    [
      "a tagged merge",
      `version: "2"\nx: &x\n  custom: {}\nlinters:\n  settings:\n    !!merge <<: *x\n`,
    ],
    ["a tagged key", `version: "2"\nlinters:\n  settings:\n    !!str custom: {}\n`],
    ["a binary key", `version: "2"\nlinters:\n  settings:\n    !!binary Y3VzdG9t: {}\n`],
    [
      "a verbatim tag",
      `version: "2"\nlinters: {settings: {!<tag:yaml.org,2002:str> custom: {}}}\n`,
    ],
    ["a tag directive", `%TAG !b! tag:yaml.org,2002:\n---\nversion: "2"\nx: !b!binary Y3VzdG9t\n`],
    ["a tag in a flow", `version: "2"\nx: [!!binary Y3VzdG9t]\n`],
    ["NEL in a comment", `version: "2"\n# c\u0085${LINTERS}\n`],
    ["LS in a comment", `version: "2"\n# c\u2028${LINTERS}\n`],
    ["PS after a value", `version: "2" # c\u2029${LINTERS}\n`],
    ["a byte order mark inside", `{version: "2",\n\uFEFF${LINTERS}}\n`],
    ["a NUL", `version: "2"\n# \u0000\n`],
  ])("%s", async (_, text) => {
    expect(await judge(".golangci.yml", text)).toBe("unreadable");
  });

  test("UTF-16", async () => {
    const file = join(dir, ".golangci.yml");
    await writeFile(file, Buffer.from(`\uFEFFversion: "2"\n`, "utf16le"));
    expect(judgeGolangciConfig(file)).toBe("unreadable");
  });

  test("allows what real configs have", async () => {
    const text = `\uFEFFversion: "2" # first\n# see !this\nlinters:\n  settings:\n    depguard:\n      rules:\n        main:\n          files: ["!$test", '!**/x.go']\n`;
    expect(await judge(".golangci.yml", text)).toBe("runnable");
  });
});

describe("findGolangciConfig", () => {
  test("takes the nearest, and golangci-lint's preference within a directory", async () => {
    await mkdir(join(dir, "a/b"), { recursive: true });
    await writeFile(join(dir, ".golangci.yml"), "");
    await writeFile(join(dir, ".golangci.toml"), "");
    expect(findGolangciConfig(join(dir, "a/b"), dir)).toBe(join(dir, ".golangci.toml"));
    await writeFile(join(dir, "a/.golangci.yaml"), "");
    expect(findGolangciConfig(join(dir, "a/b"), dir)).toBe(join(dir, "a/.golangci.yaml"));
  });

  test("does not leave the worktree", async () => {
    await mkdir(join(dir, "wt/a"), { recursive: true });
    await writeFile(join(dir, ".golangci.yml"), "");
    expect(findGolangciConfig(join(dir, "wt/a"), join(dir, "wt"))).toBeUndefined();
  });
});
