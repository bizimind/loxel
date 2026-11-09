import { describe, expect, test } from "bun:test";

import { defaultCloneDir } from "./init.ts";

describe("defaultCloneDir", () => {
  test("derives the directory from the URL", () => {
    expect(defaultCloneDir("git@github.com:org/proj.git")).toBe("proj");
    expect(defaultCloneDir("https://github.com/org/proj")).toBe("proj");
    expect(defaultCloneDir("/srv/repos/proj/.git/")).toBe("proj");
    expect(defaultCloneDir("/tmp/x/seed")).toBe("seed");
    expect(defaultCloneDir("C:\\repos\\proj.git")).toBe("proj");
    expect(() => defaultCloneDir("/".repeat(50_000))).toThrow("pass one");
  });
});
