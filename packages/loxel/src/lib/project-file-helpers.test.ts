import { describe, expect, test } from "bun:test";

import { findTreeRoot } from "./project-file-helpers";

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
