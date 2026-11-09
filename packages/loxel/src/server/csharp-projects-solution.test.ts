import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const stateDir = mkdtempSync(join(tmpdir(), "csharp-solution-state-"));
process.env.LOXEL_STATE_DIR = stateDir;
const { config } = await import("./config");
const { deleteProjectsSolution, projectsSolutionPath, writeProjectsSolution } =
  await import("./csharp-projects-solution");

afterAll(() => {
  rmSync(stateDir, { recursive: true, force: true });
});

describe("writeProjectsSolution", () => {
  test("lists each project in a folder of its own, under the state directory", async () => {
    const file = writeProjectsSolution("/wt/one", ["/wt/one/a/App.csproj", "/wt/one/b/App.csproj"]);
    expect(file).toBe(projectsSolutionPath("/wt/one"));
    expect(file.startsWith(config.stateDir)).toBe(true);
    const text = await Bun.file(file).text();
    expect(text).toContain(`"P0", "/wt/one/a/App.csproj"`);
    expect(text).toContain(`"P1", "/wt/one/b/App.csproj"`);
    expect(text).toContain(
      "{00000000-0000-0000-0002-000000000001} = {00000000-0000-0000-0001-000000000001}",
    );
  });

  test("takes spaces and special characters as they are", async () => {
    const project = "/wt/two/a b&c'<d>%41;#/Lib & Co.csproj";
    const text = await Bun.file(writeProjectsSolution("/wt/two", [project])).text();
    expect(text).toContain(`"${project}"`);
  });

  test("leaves out a path the format cannot hold, and numbers the rest in a row", async () => {
    const file = writeProjectsSolution("/wt/three", [
      '/wt/three/a"b.csproj',
      "/wt/three/a\\b.csproj",
      "/wt/three/C.csproj",
    ]);
    const text = await Bun.file(file).text();
    expect(text).not.toContain('a"b');
    expect(text).not.toContain("a\\b");
    expect(text).toContain(`"P0", "/wt/three/C.csproj"`);
  });

  test("is private to the user, and the same list leaves the file alone", () => {
    const file = writeProjectsSolution("/wt/four", ["/wt/four/App.csproj"]);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(dirname(file)).mode & 0o777).toBe(0o700);
    const { ino } = statSync(file);
    writeProjectsSolution("/wt/four", ["/wt/four/App.csproj"]);
    expect(statSync(file).ino).toBe(ino);
    writeProjectsSolution("/wt/four", ["/wt/four/Other.csproj"]);
    expect(statSync(file).ino).not.toBe(ino);
  });

  test("goes away with the worktree, leaving the others", () => {
    const gone = writeProjectsSolution("/wt/five", ["/wt/five/App.csproj"]);
    const kept = writeProjectsSolution("/wt/six", ["/wt/six/App.csproj"]);
    deleteProjectsSolution("/wt/five");
    expect(existsSync(dirname(gone))).toBe(false);
    expect(existsSync(kept)).toBe(true);
  });
});
