import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";

import {
  CACHED_FILE_DELAY_MS,
  CLANGD_IGNORED_GLOBS,
  ClangdFileChanges,
  classifyChange,
  DATABASES_DEBOUNCE_MS,
  INDEX_DIRECTORY_DEBOUNCE_MS,
  INDEX_DIRECTORY_RECHECK_MS,
  INDEX_REFRESH_QUIET_MS,
  MISSING_DATABASE_DELAY_MS,
  SOURCE_DEBOUNCE_MS,
  SOURCE_MAX_WAIT_MS,
} from "./clangd-file-changes";

describe("classifyChange", () => {
  test.each([
    ["src/a.c", "source"],
    ["include/fmt/base.h", "source"],
    ["a.C", "source"],
    ["x/y.c++", "source"],
    ["x/y.mm", "source"],
    ["compile_commands.json", "database"],
    ["build/compile_commands.json", "database"],
    ["sub/compile_flags.txt", "database"],
    [".clangd", "config"],
    ["sub/.clang-tidy", "config"],
    [".cache", "index-directory"],
    ["sub/.cache/clangd", "index-directory"],
    [".cache/clangd/index", "index-directory"],
  ])("%s is a %s change", (relPath, change) => {
    expect(classifyChange(relPath)).toBe(change as ReturnType<typeof classifyChange>);
  });

  test.each([
    ".cache/clangd/index/a.cpp.0123.idx",
    "build/.cache/clangd/index/a.h",
    "main.o",
    "README.md",
    "package.json",
    "Makefile",
  ])("%s means nothing to clangd", (relPath) => {
    expect(classifyChange(relPath)).toBeNull();
  });
});

describe("CLANGD_IGNORED_GLOBS", () => {
  const globs = CLANGD_IGNORED_GLOBS.map((glob) => new Bun.Glob(glob));
  const matched = (relPath: string) => globs.some((glob) => glob.match(relPath));

  test("take what build directories hold for clangd, and leave build output", () => {
    expect(matched("build/compile_commands.json")).toBe(true);
    expect(matched("build/generated/version.h")).toBe(true);
    expect(matched("build/x.c++")).toBe(true);
    expect(matched(".cache/clangd/index")).toBe(true);
    expect(matched("build/CMakeFiles/a.dir/a.cpp.o")).toBe(false);
    expect(matched(".cache/clangd/index/a.cpp.0123.idx")).toBe(false);
  });
});

describe("ClangdFileChanges", () => {
  let fired: string[];
  let databaseLooks: number;
  let changes: ClangdFileChanges;

  beforeEach(() => {
    jest.useFakeTimers();
    fired = [];
    databaseLooks = 0;
    changes = new ClangdFileChanges({
      recheck: () => fired.push("recheck"),
      rebuild: () => fired.push("rebuild"),
      indexDirectoryChanged: () => fired.push("index-directory"),
      isOpen: (relPath) => relPath === "open.cpp",
      refreshIndex: () => fired.push("refresh-index"),
      databasesChanged: () => {
        databaseLooks += 1;
      },
    });
  });

  afterEach(() => {
    changes.dispose();
    jest.useRealTimers();
  });

  test("a database or .clangd changing means looking again once, not a source", () => {
    changes.pathsChanged(["cmake-build-debug/compile_commands.json"]);
    changes.pathsChanged(["sub/.clangd"]);
    jest.advanceTimersByTime(DATABASES_DEBOUNCE_MS);
    expect(databaseLooks).toBe(1);
    changes.pathsChanged(["src/a.cpp"]);
    jest.advanceTimersByTime(DATABASES_DEBOUNCE_MS);
    expect(databaseLooks).toBe(1);
  });

  test("a checkout arriving in many batches gives one re-check", () => {
    for (let batch = 0; batch < 3000; batch++) {
      changes.pathsChanged([`src/f${batch}.cpp`, `include/f${batch}.h`]);
      if (batch % 500 === 0) jest.advanceTimersByTime(SOURCE_DEBOUNCE_MS / 2);
    }
    expect(fired).toEqual([]);
    jest.advanceTimersByTime(SOURCE_DEBOUNCE_MS);
    expect(fired).toEqual(["recheck"]);
    jest.advanceTimersByTime(MISSING_DATABASE_DELAY_MS);
    expect(fired.filter((action) => action === "recheck")).toHaveLength(1);
  });

  test("files that are not open refresh the index once, when they have been quiet", () => {
    changes.pathsChanged(["src/a.cpp"]);
    jest.advanceTimersByTime(INDEX_REFRESH_QUIET_MS - 1);
    changes.pathsChanged(["src/b.cpp", "src/c.h"]);
    jest.advanceTimersByTime(INDEX_REFRESH_QUIET_MS - 1);
    expect(fired).not.toContain("refresh-index");
    jest.advanceTimersByTime(1);
    expect(fired.filter((action) => action === "refresh-index")).toHaveLength(1);
  });

  test("a refresh asked for again fires then, and dispose cancels it", () => {
    changes.refreshIndexAfter(10);
    jest.advanceTimersByTime(10);
    expect(fired).toEqual(["refresh-index"]);
    changes.refreshIndexAfter(10);
    changes.dispose();
    jest.advanceTimersByTime(10);
    expect(fired).toEqual(["refresh-index"]);
  });

  test("saving an open file leaves the index to clangd", () => {
    changes.pathsChanged(["open.cpp"]);
    jest.advanceTimersByTime(INDEX_REFRESH_QUIET_MS);
    expect(fired).toEqual(["recheck"]);
  });

  test("a build that keeps writing headers still gets a re-check", () => {
    for (let elapsed = 0; elapsed < SOURCE_MAX_WAIT_MS + 1; elapsed += SOURCE_DEBOUNCE_MS / 2) {
      changes.pathsChanged(["build/gen.h"]);
      jest.advanceTimersByTime(SOURCE_DEBOUNCE_MS / 2);
    }
    expect(fired.filter((action) => action === "recheck")).toHaveLength(1);
  });

  test("anything else that changes triggers nothing", () => {
    changes.pathsChanged(["README.md", ".cache/clangd/index/a.cpp.0123.idx", "main.o"]);
    jest.advanceTimersByTime(MISSING_DATABASE_DELAY_MS);
    expect(fired).toEqual([]);
  });

  test("a compile database triggers past clangd's cache of it, found and not found", () => {
    changes.pathsChanged(["build/compile_commands.json"]);
    jest.advanceTimersByTime(CACHED_FILE_DELAY_MS - 1);
    expect(fired).toEqual([]);
    jest.advanceTimersByTime(1);
    expect(fired).toEqual(["recheck"]);
    jest.advanceTimersByTime(MISSING_DATABASE_DELAY_MS - CACHED_FILE_DELAY_MS - 1);
    expect(fired).toEqual(["recheck"]);
    jest.advanceTimersByTime(1);
    expect(fired).toEqual(["recheck", "recheck"]);
  });

  test("a configure rewriting the database moves the pending triggers, not adds to them", () => {
    for (let write = 0; write < 5; write++) {
      changes.pathsChanged(["build/compile_commands.json"]);
      jest.advanceTimersByTime(CACHED_FILE_DELAY_MS - 1);
    }
    expect(fired).toEqual([]);
    jest.advanceTimersByTime(MISSING_DATABASE_DELAY_MS);
    expect(fired).toEqual(["recheck", "recheck"]);
  });

  test.each([".clangd", ".clang-tidy", "sub/.clangd"])(
    "%s rebuilds past clangd's cache of it",
    (config) => {
      changes.pathsChanged([config]);
      jest.advanceTimersByTime(CACHED_FILE_DELAY_MS - 1);
      expect(fired).toEqual([]);
      jest.advanceTimersByTime(1);
      expect(fired).toEqual(["rebuild"]);
      jest.advanceTimersByTime(MISSING_DATABASE_DELAY_MS);
      expect(fired).toEqual(["rebuild"]);
    },
  );

  test("the index directory is looked at once for a replaced tree", () => {
    changes.pathsChanged([".cache"]);
    changes.pathsChanged([".cache/clangd", ".cache/clangd/index"]);
    jest.advanceTimersByTime(INDEX_DIRECTORY_DEBOUNCE_MS);
    expect(fired).toEqual(["index-directory"]);
    // Once more, for a checkout that had not yet written git's index.
    jest.advanceTimersByTime(INDEX_DIRECTORY_RECHECK_MS);
    expect(fired).toEqual(["index-directory", "index-directory"]);
  });

  test("dispose cancels what is pending and ignores what follows", () => {
    changes.pathsChanged(["a.h", "compile_commands.json", ".clangd", ".cache"]);
    changes.dispose();
    changes.pathsChanged(["a.h"]);
    jest.advanceTimersByTime(MISSING_DATABASE_DELAY_MS);
    expect(fired).toEqual([]);
  });
});
