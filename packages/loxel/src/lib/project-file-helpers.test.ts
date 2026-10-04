import { describe, expect, test } from "bun:test";

import { findTreeRoot, relativeTo } from "./project-file-helpers";

describe("findTreeRoot", () => {
  const roots = ["/repos/project", "/notes", "/notes/deep"];

  test("returns the root itself", () => {
    expect(findTreeRoot("/notes", roots)).toBe("/notes");
  });

  test("returns the deepest root containing the path", () => {
    expect(findTreeRoot("/notes/deep/a.md", roots)).toBe("/notes/deep");
    expect(findTreeRoot("/notes/b.md", roots)).toBe("/notes");
  });

  test("does not match a sibling with the same string prefix", () => {
    expect(findTreeRoot("/notes-old/a.md", roots)).toBeNull();
  });
});

describe("relativeTo", () => {
  test("returns the path below the root", () => {
    expect(relativeTo("/repos/project/src/a.ts", "/repos/project")).toBe("src/a.ts");
    expect(relativeTo("/repos/project/src", "/repos/project")).toBe("src");
  });

  test("returns undefined for the root itself", () => {
    expect(relativeTo("/repos/project", "/repos/project")).toBeUndefined();
  });

  test("returns undefined outside the root, including a sibling with the same string prefix", () => {
    expect(relativeTo("/repos/other/a.ts", "/repos/project")).toBeUndefined();
    expect(relativeTo("/repos/project-old/a.ts", "/repos/project")).toBeUndefined();
  });
});
