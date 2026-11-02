import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { DEFAULT_FORMATTING_SETTINGS } from "@/lib/formatting-model";
import { EXT_TO_LANG } from "@/lib/highlighter";
import "@/test/temp-state-dir";

import { clangFormatter } from "./clang-formatter";
import { FormatService } from "./format-service";

/** Set to a real binary to compare the ignore rules against it; CI has none. */
const REAL_CLANG_FORMAT = process.env.LOXEL_TEST_CLANG_FORMAT;
const REAL_PATH = process.env.PATH;
const C_FAMILY = new Set(["c", "cpp", "objective-c", "objective-cpp"]);
/** Also MATLAB and SWIG, which clang-format would corrupt, so left to a manual override. */
const NOT_AUTO_FORMATTED = new Set(["m", "i"]);

let temp: string;
let tools: string;
let wt: string;

async function addFiles(files: Record<string, string>): Promise<void> {
  for (const [name, content] of Object.entries(files)) {
    await mkdir(dirname(join(wt, name)), { recursive: true });
    await writeFile(join(wt, name), content);
  }
}

/** A fake clang-format that reports how it ran, using only shell builtins. */
async function installFake(dir = tools, script?: string): Promise<void> {
  const report = 'echo "fake cwd=$PWD args=$*"\n';
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "clang-format"), `#!/bin/sh\n${script ?? report}`);
  await chmod(join(dir, "clang-format"), 0o755);
}

function save(name: string): Promise<{ content: string | null; notice?: string }> {
  return new FormatService().format("int  a;\n", join(wt, name), wt, DEFAULT_FORMATTING_SETTINGS);
}

/** Whether the module detects clang-format for this worktree-relative file. */
function detects(name: string): boolean {
  const path = join(wt, name);
  return clangFormatter.detect(dirname(path), wt, path.slice(dirname(path).length + 1)) !== null;
}

beforeEach(async () => {
  temp = await realpath(await mkdtemp(join(tmpdir(), "clang-formatter-")));
  tools = join(temp, "tools");
  wt = join(temp, "wt");
  await mkdir(tools);
  await mkdir(wt);
  process.env.PATH = tools;
});

afterEach(async () => {
  await rm(temp, { recursive: true, force: true });
});

afterAll(() => {
  process.env.PATH = REAL_PATH;
});

describe("clangFormatter selection", () => {
  test("claims the C-family extensions the editor highlights, except the ambiguous ones", () => {
    const family = Object.entries(EXT_TO_LANG)
      .filter(([ext, language]) => C_FAMILY.has(language) && !NOT_AUTO_FORMATTED.has(ext))
      .map(([ext]) => ext);
    expect([...clangFormatter.extensions].sort()).toEqual(family.sort());
  });

  test("an upper-case extension formats too", async () => {
    await addFiles({ ".clang-format": "" });
    await installFake();
    expect((await save("a.C")).content).toStartWith("fake ");
    expect((await save("a.H")).content).toStartWith("fake ");
  });

  test("leaves .m and .i alone, and a manual override still formats them", async () => {
    await addFiles({ ".clang-format": "", "node_modules/.keep": "" });
    await installFake();
    expect(await save("a.m")).toEqual({ content: null });
    expect(await save("a.i")).toEqual({ content: null });
    const result = await new FormatService().format("x", join(wt, "a.m"), wt, {
      ...DEFAULT_FORMATTING_SETTINGS,
      overrides: [
        { id: "objc", extensions: "m", command: "clang-format", args: "--assume-filename={file}" },
      ],
    });
    expect(result.content).toBe(`fake cwd=${wt} args=--assume-filename=${join(wt, "a.m")}\n`);
  });

  test("does nothing without a config, where clang-format would apply LLVM style", async () => {
    await installFake();
    expect(await save("a.c")).toEqual({ content: null });
    expect(new FormatService().getDetectedFormatters(wt)).toEqual([]);
  });

  test("finds the nearest config of either name, from the file up to the worktree", async () => {
    await addFiles({ "native/.clang-format": "", "other/lib/_clang-format": "" });
    expect(detects("native/src/a.cpp")).toBe(true);
    expect(detects("other/lib/a.mm")).toBe(true);
    expect(detects("other/a.c")).toBe(false);
    expect(detects("a.c")).toBe(false);
  });

  test("a directory is passed over, and an oversized nearest config stops the search", async () => {
    await mkdir(join(wt, ".clang-format"));
    expect(detects("a.c")).toBe(false);
    await addFiles({ "_clang-format": "", "big/.clang-format": "#".repeat(1_024 * 1_024 + 1) });
    expect(detects("a.c")).toBe(true);
    expect(detects("big/a.c")).toBe(false);
  });

  test("a link that cannot resolve is passed over", async () => {
    await symlink(".clang-format", join(wt, ".clang-format"));
    await symlink(".clang-format-ignore", join(wt, ".clang-format-ignore"));
    await addFiles({ "_clang-format": "" });
    expect(detects("a.c")).toBe(true);
  });

  test("a config above the worktree does not count, nor does a file outside it", async () => {
    await writeFile(join(temp, ".clang-format"), "");
    expect(detects("a.c")).toBe(false);
    await addFiles({ ".clang-format": "" });
    expect(clangFormatter.detect(join(temp, "elsewhere"), wt, "a.c")).toBeNull();
  });

  test("Settings lists it for a config at the worktree root", async () => {
    await addFiles({ ".clang-format": "" });
    const [listed] = new FormatService().getDetectedFormatters(wt);
    expect(listed?.command).toBe("clang-format");
    expect(listed?.extensions).toContain("mm");
  });
});

describe("clangFormatter spawning", () => {
  test("runs from the filesystem root with the file's absolute path", async () => {
    await addFiles({ "native/.clang-format": "" });
    await installFake();
    const result = await new FormatService().format(
      "int  a;\n",
      "native/a.c",
      wt,
      DEFAULT_FORMATTING_SETTINGS,
    );
    expect(result.content).toBe(`fake cwd=/ args=--assume-filename=${join(wt, "native/a.c")}\n`);
  });

  test("uses nothing from the worktree, on PATH or in node_modules/.bin", async () => {
    await addFiles({ ".clang-format": "" });
    const repoBin = join(wt, "bin");
    await installFake(repoBin);
    await installFake(join(wt, "node_modules", ".bin"));
    process.env.PATH = `${repoBin}:bin:.:${tools}`;
    await installFake(tools, 'echo "from tools"\n');
    expect((await save("a.c")).content).toBe("from tools\n");
  });

  test("a missing binary says what to run", async () => {
    await addFiles({ ".clang-format": "" });
    const { content, notice } = await save("a.c");
    expect(content).toBeNull();
    expect(notice).toContain("brew install clang-format");
  });

  test("an invalid config says what is wrong, other failures stay quiet", async () => {
    await addFiles({ ".clang-format": "" });
    const error = "/repo/.clang-format:1:1: error: unknown key 'Nope'";
    await installFake(tools, `echo "${error}" >&2\necho "Error reading: x" >&2\nexit 1\n`);
    const { content, notice } = await save("a.c");
    expect(content).toBeNull();
    expect(notice).toContain(error);
    expect(notice).not.toContain("Error reading");

    await installFake(tools, 'echo "crashed" >&2\nexit 1\n');
    expect(await save("a.c")).toEqual({ content: null });
  });

  test("a manual override of another command keeps the defaults", async () => {
    await addFiles({ ".clang-format": "" });
    const bin = join(wt, "node_modules", ".bin");
    await mkdir(bin, { recursive: true });
    await writeFile(join(bin, "my-fmt"), '#!/bin/sh\necho "other cwd=$PWD"\n');
    await chmod(join(bin, "my-fmt"), 0o755);
    const result = await new FormatService().format("x", join(wt, "a.c"), wt, {
      ...DEFAULT_FORMATTING_SETTINGS,
      overrides: [{ id: "override", extensions: "c", command: "my-fmt", args: "" }],
    });
    expect(result.content).toBe(`other cwd=${wt}\n`);
  });
});

describe.skipIf(!REAL_CLANG_FORMAT)("clangFormatter with a real clang-format", () => {
  beforeEach(async () => {
    await mkdir(tools, { recursive: true });
    await symlink(REAL_CLANG_FORMAT ?? "", join(tools, "clang-format"));
  });

  for (const [problem, config, expected] of [
    ["an unknown key", "NoSuchKey: 1\n", "error: unknown key 'NoSuchKey'"],
    ["bad YAML", "IndentWidth: [\n", "error:"],
    ["no section for the language", "Language: JavaScript\n", "do(es) not support"],
    ["a duplicate section", "---\nLanguage: Cpp\n---\nLanguage: Cpp\n", "Error reading "],
  ] as const) {
    test(`a config with ${problem} gives a notice`, async () => {
      await addFiles({ ".clang-format": config });
      const { content, notice } = await save("a.c");
      expect(content).toBeNull();
      expect(notice).toContain(expected);
    });
  }

  test("code with syntax errors stays quiet", async () => {
    await addFiles({ ".clang-format": "" });
    const service = new FormatService();
    const broken = 'int main( { if ( \n "unterminated\n';
    const result = await service.format(broken, join(wt, "a.c"), wt, DEFAULT_FORMATTING_SETTINGS);
    expect(result.notice).toBeUndefined();
  });
});

/** Patterns of a root ignore file, and whether `clang-format` ignores each file with them. */
const IGNORE_CASES: { patterns: string; ignored: string[]; formatted: string[] }[] = [
  { patterns: "a.c\n", ignored: ["a.c"], formatted: ["b.c", "sub/a.c"] },
  { patterns: "*\n", ignored: ["a.c", "b.c"], formatted: ["sub/a.c"] },
  { patterns: "sub/*\n", ignored: ["sub/a.c"], formatted: ["a.c", "sub/deep/a.c"] },
  { patterns: "sub\n", ignored: [], formatted: ["sub/a.c"] },
  { patterns: "sub/\n", ignored: [], formatted: ["sub/a.c"] },
  { patterns: "**\n", ignored: ["a.c", "sub/deep/a.c"], formatted: [] },
  { patterns: "**/a.c\n", ignored: ["a.c", "sub/a.c", "sub/deep/a.c"], formatted: ["b.c"] },
  { patterns: "sub/**/a.c\n", ignored: ["sub/a.c", "sub/deep/a.c"], formatted: ["a.c", "sub/b.c"] },
  { patterns: "sub/**\n", ignored: ["sub/a.c", "sub/deep/a.c"], formatted: ["a.c"] },
  { patterns: "*/a.c\n", ignored: ["sub/a.c"], formatted: ["a.c", "sub/deep/a.c"] },
  { patterns: "?.c\n", ignored: ["a.c", "b.c"], formatted: ["ab.c", "sub/a.c"] },
  { patterns: "[ab].c\n", ignored: ["a.c", "b.c"], formatted: ["c.c"] },
  { patterns: "[!a].c\n", ignored: ["b.c"], formatted: ["a.c"] },
  { patterns: "[a-c].c\n", ignored: ["b.c"], formatted: ["d.c"] },
  { patterns: "a\\.c\n", ignored: ["a.c"], formatted: ["abc"] },
  { patterns: "./a.c\n", ignored: ["a.c"], formatted: ["b.c"] },
  { patterns: "sub/../a.c\n", ignored: ["a.c"], formatted: ["sub/a.c"] },
  { patterns: "# a.c\n\n  b.c  \r\n", ignored: ["b.c"], formatted: ["a.c"] },
  { patterns: "*\n!a.c\n", ignored: ["b.c"], formatted: ["a.c", "sub/a.c"] },
  { patterns: "!a.c\n*\n", ignored: ["a.c", "b.c"], formatted: ["sub/a.c"] },
  { patterns: "*.c\n! a.c\n", ignored: ["b.c"], formatted: ["a.c"] },
  { patterns: "!\n\\#x.c\n", ignored: ["#x.c"], formatted: ["x.c"] },
  // Bytes, not characters, as "é" is two in UTF-8.
  { patterns: "??.c\n", ignored: ["é.c", "ab.c"], formatted: ["a.c"] },
  { patterns: "?.c\n", ignored: ["a.c"], formatted: ["é.c"] },
  { patterns: "[é].c\n", ignored: [], formatted: ["é.c"] },
  { patterns: "é.c\n", ignored: ["é.c"], formatted: ["e.c"] },
  // Only ASCII whitespace is trimmed.
  { patterns: "a.c\u00a0\n", ignored: [], formatted: ["a.c"] },
  { patterns: "\ufeffa.c\n", ignored: [], formatted: ["a.c"] },
];

describe("clangFormatter ignore files", () => {
  for (const { patterns, ignored, formatted } of IGNORE_CASES) {
    test(`patterns ${JSON.stringify(patterns)}`, async () => {
      await addFiles({ ".clang-format": "", ".clang-format-ignore": patterns });
      for (const name of ignored) expect([name, detects(name)]).toEqual([name, false]);
      for (const name of formatted) expect([name, detects(name)]).toEqual([name, true]);
    });

    test.skipIf(!REAL_CLANG_FORMAT)(
      `real clang-format agrees: ${JSON.stringify(patterns)}`,
      async () => {
        await addFiles({ ".clang-format": "", ".clang-format-ignore": patterns });
        for (const name of [...ignored, ...formatted]) await addFiles({ [name]: "int a;\n" });
        const proc = Bun.spawn(
          [REAL_CLANG_FORMAT ?? "", "--list-ignored", ...ignored, ...formatted],
          { cwd: wt, stdout: "pipe" },
        );
        const listed = (await new Response(proc.stdout).text()).split("\n").filter(Boolean);
        expect(listed.sort()).toEqual([...ignored].sort());
      },
    );
  }

  test("the nearest ignore file replaces the ones above, relative to its own directory", async () => {
    await addFiles({
      ".clang-format": "",
      ".clang-format-ignore": "**\n",
      "sub/.clang-format-ignore": "a.c\n",
    });
    expect(detects("b.c")).toBe(false);
    expect(detects("sub/a.c")).toBe(false);
    expect(detects("sub/b.c")).toBe(true);
    expect(detects("sub/deep/a.c")).toBe(true);
  });

  test("a directory of that name is passed over", async () => {
    await addFiles({ ".clang-format": "", ".clang-format-ignore": "sub/a.c\n" });
    await mkdir(join(wt, "sub", ".clang-format-ignore"), { recursive: true });
    expect(detects("sub/a.c")).toBe(false);
    expect(detects("sub/b.c")).toBe(true);
  });

  test("an ignored file saves unformatted, with no notice", async () => {
    await addFiles({ ".clang-format": "", ".clang-format-ignore": "a.c\n" });
    await installFake();
    expect(await save("a.c")).toEqual({ content: null });
    expect((await save("b.c")).content).toStartWith("fake ");
  });

  test("an ignore file too large to read leaves the file alone", async () => {
    await addFiles({ ".clang-format": "", ".clang-format-ignore": "#".repeat(64 * 1_024 + 1) });
    expect(detects("a.c")).toBe(false);
  });

  test("patterns too complex to match leave the file alone", async () => {
    const patterns = `${"*a".repeat(50)}b\n`.repeat(600);
    await addFiles({ ".clang-format": "", ".clang-format-ignore": patterns });
    await installFake();
    expect(await save(`${"a".repeat(200)}.c`)).toEqual({ content: null });
  });
});
