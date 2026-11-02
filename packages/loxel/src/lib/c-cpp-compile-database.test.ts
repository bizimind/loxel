import { describe, expect, test } from "bun:test";

import type {
  CompileDatabaseFileResponse,
  CompileDatabaseStatus,
} from "@/api/c-cpp-compile-database-model";

import {
  automaticDescription,
  compileDatabaseSummary,
  compileDatabaseTooltip,
} from "./c-cpp-compile-database";

const WT = "/wt";
const STATUS: CompileDatabaseStatus = {
  chosen: null,
  chosenUsable: false,
  automatic: null,
  candidates: [],
  foundByClangd: [],
  searchCut: false,
  namesOutsideDatabase: false,
};
const NONE: CompileDatabaseFileResponse = {
  database: null,
  clangdConfig: null,
  hint: "Run cmake -B build -DCMAKE_EXPORT_COMPILE_COMMANDS=ON in a terminal",
};

function found(
  path: string,
  source: NonNullable<CompileDatabaseFileResponse["database"]>["source"] = "search",
): CompileDatabaseFileResponse {
  return { database: { path, source }, clangdConfig: null, hint: null };
}

describe("compileDatabaseSummary", () => {
  test.each([
    ["/wt/cmake-build-debug/compile_commands.json", "C++ (cmake-build-debug)"],
    ["/wt/build/compile_commands.json", "C++ (build)"],
    ["/wt/sub/build/compile_commands.json", "C++ (sub/build)"],
    ["/wt/compile_commands.json", "C++ (compile_commands.json)"],
    ["/wt/compile_flags.txt", "C++ (compile_flags.txt)"],
    ["/wt/sub/compile_flags.txt", "C++ (sub/compile_flags.txt)"],
    ["/elsewhere/debug/compile_commands.json", "C++ (debug)"],
  ])("%s reads %s", (path, label) => {
    expect(compileDatabaseSummary("cpp", WT, STATUS, found(path))).toEqual({
      label,
      warning: false,
    });
  });

  test("names the file's language", () => {
    const file = found("/wt/build/compile_commands.json");
    expect(compileDatabaseSummary("c", WT, STATUS, file).label).toBe("C (build)");
    expect(compileDatabaseSummary("objective-c", WT, STATUS, file).label).toBe(
      "Objective-C (build)",
    );
  });

  test("warns with none, and asks when there is something to choose", () => {
    expect(compileDatabaseSummary("cpp", WT, STATUS, NONE)).toEqual({
      label: "C++ (no compile database)",
      warning: true,
    });
    const candidates = ["/wt/cmake-build-debug", "/wt/cmake-build-release"];
    expect(compileDatabaseSummary("cpp", WT, { ...STATUS, candidates }, NONE)).toEqual({
      label: "C++ (choose a compile database)",
      warning: true,
    });
  });

  test("a .clangd's own decision is not something to warn about", () => {
    const none = { ...NONE, clangdConfig: { path: "/wt/.clangd", effect: "none" as const } };
    expect(compileDatabaseSummary("cpp", WT, STATUS, none)).toEqual({
      label: "C++ (no compile database)",
      warning: false,
    });
    const flags = { ...NONE, clangdConfig: { path: "/wt/.clangd", effect: "flags" as const } };
    expect(compileDatabaseSummary("cpp", WT, STATUS, flags)).toEqual({
      label: "C++ (.clangd flags)",
      warning: false,
    });
  });

  test("warns when the chosen folder has no database, whatever took over", () => {
    const status = { ...STATUS, chosen: "/gone" };
    const file = found("/wt/build/compile_commands.json");
    expect(compileDatabaseSummary("cpp", WT, status, file).warning).toBe(true);
  });
});

describe("automaticDescription", () => {
  test("gives the reason a lone candidate wasn't picked, not that there are several", () => {
    const status = { ...STATUS, candidates: ["/wt/cmake-build-debug"], searchCut: true };
    expect(automaticDescription(status, WT)).toBe("Worktree too large to check; none picked");
  });

  test("says when there are several", () => {
    const candidates = ["/wt/cmake-build-debug", "/wt/cmake-build-release"];
    expect(automaticDescription({ ...STATUS, candidates }, WT)).toBe("Several found; none picked");
  });
});

describe("compileDatabaseTooltip", () => {
  test("gives the path and how it was found", () => {
    const path = "/wt/cmake-build-debug/compile_commands.json";
    const tooltip = compileDatabaseTooltip(WT, STATUS, found(path, "automatic"));
    expect(tooltip).toContain(path);
    expect(tooltip).toContain("Found automatically");
    expect(tooltip).toContain("every file");
  });

  test("gives what to run when there is none", () => {
    const tooltip = compileDatabaseTooltip(WT, STATUS, NONE);
    expect(tooltip).toContain("guessing");
    expect(tooltip).toContain("cmake -B build -DCMAKE_EXPORT_COMPILE_COMMANDS=ON");
  });

  test("says why a lone candidate isn't used", () => {
    const status = {
      ...STATUS,
      candidates: ["/wt/cmake-build-debug"],
      foundByClangd: ["/wt/sub/build/compile_commands.json"],
    };
    const tooltip = compileDatabaseTooltip(WT, status, NONE);
    expect(tooltip).toContain("Found in: cmake-build-debug.");
    expect(tooltip).toContain("Not used by itself");
  });

  test("offers no command for a project that turned the database off", () => {
    const file = { ...NONE, clangdConfig: { path: "/wt/.clangd", effect: "none" as const } };
    const tooltip = compileDatabaseTooltip(WT, STATUS, file);
    expect(tooltip).toContain("/wt/.clangd turns the compile database off.");
    expect(tooltip).not.toContain("cmake");
  });
});
