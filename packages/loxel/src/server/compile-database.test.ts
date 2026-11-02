import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import "@/test/temp-state-dir";

import {
  compileCommandsDir,
  type CompileDatabaseUpdate,
  normalizeCompileDatabaseChoice,
  refreshCompileDatabases,
  resolveCompileDatabases,
  resolveFileCompileDatabase,
  subscribeCompileDatabases,
} from "./compile-database";
import { setCompileDatabaseChoice } from "./compile-database-store";

const COMMANDS = '[{"directory":"/","file":"a.cpp","arguments":["c++","a.cpp"]}]\n';
const dirs: string[] = [];

async function makeDir(): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "compile-database-")));
  dirs.push(dir);
  return dir;
}

async function write(root: string, relPath: string, content = COMMANDS): Promise<string> {
  const file = join(root, relPath);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, content);
  return file;
}

afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("what clangd finds for a file", () => {
  async function found(root: string, relFile = "src/a.cpp"): Promise<string | null> {
    return (await resolveFileCompileDatabase(root, join(root, relFile))).database?.path ?? null;
  }

  test("within a folder: compile_commands.json, then build's, then compile_flags.txt", async () => {
    const root = await makeDir();
    const flags = await write(root, "compile_flags.txt", "-DX\n");
    expect(await found(root)).toBe(flags);
    const build = await write(root, "build/compile_commands.json");
    expect(await found(root)).toBe(build);
    const direct = await write(root, "compile_commands.json");
    expect(await found(root)).toBe(direct);
  });

  test("the nearest folder wins, of either kind", async () => {
    const root = await makeDir();
    await write(root, "compile_commands.json");
    const near = await write(root, "src/compile_flags.txt", "-DX\n");
    expect(await found(root)).toBe(near);
  });

  test("build/compile_flags.txt is not one", async () => {
    const root = await makeDir();
    await write(root, "build/compile_flags.txt", "-DX\n");
    expect(await found(root)).toBeNull();
  });

  test("passes over a compile_commands.json that clangd cannot load, for the next", async () => {
    const root = await makeDir();
    await write(root, "src/compile_commands.json", "{not json");
    const above = await write(root, "compile_commands.json");
    expect(await found(root)).toBe(above);
  });

  test("follows a link to a compile database, as clangd does", async () => {
    const root = await makeDir();
    const real = await write(root, "cmake-build-debug/compile_commands.json");
    const link = join(root, "compile_commands.json");
    await symlink(real, link);
    expect(await found(root)).toBe(link);
  });

  test("reports the source and no hint", async () => {
    const root = await makeDir();
    const file = await write(root, "compile_commands.json");
    expect(await resolveFileCompileDatabase(root, join(root, "a.cpp"))).toEqual({
      database: { path: file, source: "search" },
      clangdConfig: null,
      hint: null,
    });
  });
});

describe(".clangd", () => {
  const database = (value: string) => `CompileFlags:\n  CompilationDatabase: ${value}\n`;

  test("a relative CompilationDatabase is from its own folder, and goes before the search", async () => {
    const root = await makeDir();
    await write(root, "compile_commands.json");
    const named = await write(root, "elsewhere/compile_commands.json");
    await write(root, ".clangd", database("elsewhere"));
    const { database: found } = await resolveFileCompileDatabase(root, join(root, "src/a.cpp"));
    expect(found).toEqual({ path: named, source: "clangd-config" });
  });

  test("the nearest one wins, in any document of the file", async () => {
    const root = await makeDir();
    await write(root, "outer/compile_commands.json");
    const inner = await write(root, "inner/compile_commands.json");
    await write(root, ".clangd", database("outer"));
    await write(root, "src/.clangd", `Diagnostics: {}\n---\n${database("../inner")}`);
    const { database: found } = await resolveFileCompileDatabase(root, join(root, "src/a.cpp"));
    expect(found?.path).toBe(inner);
  });

  test("None and a folder with nothing mean no database, and no search", async () => {
    const root = await makeDir();
    await write(root, "compile_commands.json");
    const config = await write(root, ".clangd", database("None"));
    const off = await resolveFileCompileDatabase(root, join(root, "a.cpp"));
    expect(off.database).toBeNull();
    expect(off.clangdConfig).toEqual({ path: config, effect: "none" });
    await write(root, ".clangd", database("nowhere"));
    const missing = await resolveFileCompileDatabase(root, join(root, "a.cpp"));
    expect(missing.database).toBeNull();
    expect(missing.clangdConfig).toEqual({ path: config, effect: "missing" });
  });

  test("Ancestors leaves the search as it is", async () => {
    const root = await makeDir();
    const file = await write(root, "compile_commands.json");
    await write(root, ".clangd", database("Ancestors"));
    const { database: found } = await resolveFileCompileDatabase(root, join(root, "a.cpp"));
    expect(found).toEqual({ path: file, source: "search" });
    expect((await resolveCompileDatabases(root)).foundByClangd).toEqual([file]);
  });

  test("Add alone is reported when no database applies, and still takes a candidate", async () => {
    const root = await makeDir();
    const config = await write(root, ".clangd", "CompileFlags:\n  Add: [-DX]\n");
    const file = await resolveFileCompileDatabase(root, join(root, "a.cpp"));
    expect(file.clangdConfig).toEqual({ path: config, effect: "flags" });
    await write(root, "cmake-build-debug/compile_commands.json");
    expect((await resolveCompileDatabases(root)).automatic).toBe(join(root, "cmake-build-debug"));
  });

  test("a CompilationDatabase under a condition keeps the flag away", async () => {
    const root = await makeDir();
    await write(root, "cmake-build-debug/compile_commands.json");
    await write(root, "sub/.clangd", `If:\n  PathMatch: .*\n${database("x")}`);
    expect((await resolveCompileDatabases(root)).automatic).toBeNull();
  });

  test("one that does not parse has no effect", async () => {
    const root = await makeDir();
    await write(root, ".clangd", "CompileFlags: [unclosed\n");
    const file = await resolveFileCompileDatabase(root, join(root, "a.cpp"));
    expect(file.database).toBeNull();
    expect(file.clangdConfig).toBeNull();
  });
});

describe("non-standard candidates", () => {
  test.each(["cmake-build-debug", "build-debug", "build/debug", "out/x", "out/build/x"])(
    "%s is one",
    async (relDir) => {
      const root = await makeDir();
      await write(root, `${relDir}/compile_commands.json`);
      const status = await resolveCompileDatabases(root);
      expect(status.candidates).toEqual([join(root, relDir)]);
      expect(status.automatic).toBe(join(root, relDir));
      expect(compileCommandsDir(status)).toBe(join(root, relDir));
    },
  );

  test("names that are not build folders aren't, nor is compile_flags.txt", async () => {
    const root = await makeDir();
    await write(root, "bin/compile_commands.json");
    await write(root, "sub/cmake-build-debug/compile_commands.json");
    await write(root, "build-debug/compile_flags.txt", "-DX\n");
    expect((await resolveCompileDatabases(root)).candidates).toEqual([]);
  });

  test("a malformed one isn't", async () => {
    const root = await makeDir();
    await write(root, "cmake-build-debug/compile_commands.json", "[half a file");
    expect((await resolveCompileDatabases(root)).candidates).toEqual([]);
  });

  test("links are not followed, to a folder or to the file", async () => {
    const root = await makeDir();
    const outside = await makeDir();
    const held = await write(outside, "compile_commands.json");
    await symlink(outside, join(root, "cmake-build-link"));
    await mkdir(join(root, "cmake-build-file"));
    await symlink(held, join(root, "cmake-build-file", "compile_commands.json"));
    await symlink(outside, join(root, "out"));
    await mkdir(join(outside, "x"));
    await write(outside, "x/compile_commands.json");
    expect((await resolveCompileDatabases(root)).candidates).toEqual([]);
  });

  test("several are listed and none is picked", async () => {
    const root = await makeDir();
    await write(root, "cmake-build-debug/compile_commands.json");
    await write(root, "cmake-build-release/compile_commands.json");
    const status = await resolveCompileDatabases(root);
    expect(status.candidates).toHaveLength(2);
    expect(status.automatic).toBeNull();
    expect(compileCommandsDir(status)).toBeNull();
  });

  test.each([
    ["the root", "compile_commands.json"],
    ["the root's build", "build/compile_commands.json"],
    ["the root's flags file", "compile_flags.txt"],
    ["a subproject", "sub/compile_commands.json"],
    ["a subproject's build", "deep/er/sub/build/compile_commands.json"],
  ])("none is picked when clangd finds one for %s", async (_name, relPath) => {
    const root = await makeDir();
    await write(root, "cmake-build-debug/compile_commands.json");
    const own = await write(root, relPath, relPath.endsWith(".txt") ? "-DX\n" : COMMANDS);
    const status = await resolveCompileDatabases(root);
    expect(status.candidates).toEqual([join(root, "cmake-build-debug")]);
    expect(status.automatic).toBeNull();
    expect(status.foundByClangd).toEqual([own]);
  });

  test("none is picked when the worktree is too large to search whole", async () => {
    const root = await makeDir();
    await write(root, "cmake-build-debug/compile_commands.json");
    await Promise.all(
      Array.from({ length: 5001 }, (_, index) =>
        mkdir(join(root, "src", `d${index}`), { recursive: true }),
      ),
    );
    const status = await resolveCompileDatabases(root);
    expect(status.searchCut).toBe(true);
    expect(status.automatic).toBeNull();
  });
});

describe("a choice", () => {
  test("is a folder or a database file in one, anywhere", async () => {
    const root = await makeDir();
    const outside = await makeDir();
    const file = await write(outside, "compile_commands.json");
    expect(await normalizeCompileDatabaseChoice(root, outside)).toBe(outside);
    expect(await normalizeCompileDatabaseChoice(root, file)).toBe(outside);
    await write(root, "rel/compile_flags.txt", "-DX\n");
    expect(await normalizeCompileDatabaseChoice(root, " rel ")).toBe(join(root, "rel"));
  });

  test("is refused where there is no database", async () => {
    const root = await makeDir();
    await expect(normalizeCompileDatabaseChoice(root, "nowhere")).rejects.toThrow(
      `No usable compile_commands.json or compile_flags.txt in ${join(root, "nowhere")}`,
    );
    await expect(normalizeCompileDatabaseChoice(root, "  ")).rejects.toThrow("Enter the path");
    await write(root, "bad/compile_commands.json", "nope");
    await expect(normalizeCompileDatabaseChoice(root, "bad")).rejects.toThrow("No usable");
  });

  test("applies to every file, over clangd's own search", async () => {
    const root = await makeDir();
    const outside = await makeDir();
    const chosen = await write(outside, "compile_commands.json");
    await write(root, "sub/compile_commands.json");
    setCompileDatabaseChoice(root, outside);
    const status = await resolveCompileDatabases(root);
    expect(compileCommandsDir(status)).toBe(outside);
    const { database } = await resolveFileCompileDatabase(root, join(root, "sub/a.cpp"));
    expect(database).toEqual({ path: chosen, source: "chosen" });
    setCompileDatabaseChoice(root, null);
  });

  test("that no longer holds a database is reported, and detection takes over", async () => {
    const root = await makeDir();
    await write(root, "cmake-build-debug/compile_commands.json");
    setCompileDatabaseChoice(root, join(root, "gone"));
    const status = await resolveCompileDatabases(root);
    expect(status.chosen).toBe(join(root, "gone"));
    expect(status.chosenUsable).toBe(false);
    expect(compileCommandsDir(status)).toBe(join(root, "cmake-build-debug"));
    setCompileDatabaseChoice(root, null);
  });
});

describe("the hint for a file with no database", () => {
  async function hint(root: string, relFile: string): Promise<string | null> {
    return (await resolveFileCompileDatabase(root, join(root, relFile))).hint;
  }

  test.each([
    ["CMakeLists.txt", "cmake -B build -DCMAKE_EXPORT_COMPILE_COMMANDS=ON"],
    ["meson.build", "meson setup build"],
    ["Makefile", "bear -- make"],
  ])("%s says what to run", async (name, command) => {
    const root = await makeDir();
    await write(root, name, "");
    expect(await hint(root, "src/a.c")).toBe(`Run ${command} in a terminal`);
  });

  test("goes by the outermost build file of the worktree", async () => {
    const root = await makeDir();
    await write(root, "sub/CMakeLists.txt", "");
    await write(root, "sub/src/CMakeLists.txt", "");
    expect(await hint(root, "sub/src/a.cpp")).toContain("in a terminal, in sub");
  });

  test("without a build file, says what would do", async () => {
    expect(await hint(await makeDir(), "a.c")).toContain("compile_flags.txt");
  });
});

describe("following a worktree", () => {
  function nextUpdate(root: string): { update: Promise<CompileDatabaseUpdate>; stop: () => void } {
    const { promise, resolve } = Promise.withResolvers<CompileDatabaseUpdate>();
    return { update: promise, stop: subscribeCompileDatabases(root, resolve) };
  }

  test("a new database is a change, and looking again with none is not", async () => {
    const root = await makeDir();
    const first = nextUpdate(root);
    refreshCompileDatabases(root);
    expect((await first.update).status.automatic).toBeNull();

    await write(root, "cmake-build-debug/compile_commands.json");
    const second = nextUpdate(root);
    refreshCompileDatabases(root);
    const update = await second.update;
    expect(update.changed).toBe(true);
    expect(update.status.automatic).toBe(join(root, "cmake-build-debug"));

    const third = nextUpdate(root);
    refreshCompileDatabases(root);
    expect((await third.update).changed).toBe(false);
    for (const { stop } of [first, second, third]) stop();
  });
});
