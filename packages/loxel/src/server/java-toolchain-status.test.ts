import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { nearestBuildTool } from "./java-toolchain-status";

const root = realpathSync(mkdtempSync(path.join(tmpdir(), "java-build-file-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function file(relative: string): string {
  const target = path.join(root, relative);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, "");
  return target;
}

describe("nearestBuildTool", () => {
  test("finds the build file nearest the source file, per module", () => {
    file("wt/mod/pom.xml");
    file("wt/gr/build.gradle.kts");
    const wt = path.join(root, "wt");
    expect(nearestBuildTool(wt, file("wt/mod/src/main/java/M.java"))).toBe("Maven");
    expect(nearestBuildTool(wt, file("wt/gr/src/G.java"))).toBe("Gradle");
  });

  test("finds none in a folder beside the modules", () => {
    expect(nearestBuildTool(path.join(root, "wt"), file("wt/other/O.java"))).toBeNull();
  });

  test("reads a build file at the worktree's root", () => {
    file("rooted/pom.xml");
    expect(nearestBuildTool(path.join(root, "rooted"), file("rooted/a/b/C.java"))).toBe("Maven");
  });

  test("does not look above the worktree or for a file outside it", () => {
    file("outer/pom.xml");
    const wt = path.join(root, "outer", "wt");
    expect(nearestBuildTool(wt, file("outer/wt/A.java"))).toBeNull();
    expect(nearestBuildTool(wt, file("outer/B.java"))).toBeNull();
  });
});
