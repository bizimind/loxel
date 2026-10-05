import { describe, expect, test } from "bun:test";

import { findTypeaheadMatch } from "./useTreeKeyboardNav";

describe("findTypeaheadMatch", () => {
  const names = ["src", "alpha.md", "beta.md", "build.ts", "aardvark"];

  test("a single character searches from the row after the current one, wrapping around", () => {
    expect(findTypeaheadMatch(names, 2, "b")).toBe(3);
    expect(findTypeaheadMatch(names, 3, "b")).toBe(2);
    expect(findTypeaheadMatch(names, 4, "s")).toBe(0);
  });

  test("with no current row the search starts at the first row", () => {
    expect(findTypeaheadMatch(names, -1, "s")).toBe(0);
    expect(findTypeaheadMatch(names, -1, "bu")).toBe(3);
  });

  test("a longer prefix keeps the current row while it matches", () => {
    expect(findTypeaheadMatch(names, 2, "be")).toBe(2);
    expect(findTypeaheadMatch(names, 2, "bu")).toBe(3);
  });

  test("a repeated character steps through the names starting with it", () => {
    expect(findTypeaheadMatch(names, 1, "aa")).toBe(4);
    expect(findTypeaheadMatch(names, 2, "bb")).toBe(3);
    // Even when the current row starts with the run itself.
    expect(findTypeaheadMatch(names, 4, "aa")).toBe(1);
    expect(findTypeaheadMatch(["ssh.ts", "ssr.ts"], 0, "ss")).toBe(1);
  });

  test("returns -1 when nothing matches", () => {
    expect(findTypeaheadMatch(names, 0, "z")).toBe(-1);
    expect(findTypeaheadMatch(names, 0, "bz")).toBe(-1);
    expect(findTypeaheadMatch([], -1, "a")).toBe(-1);
  });
});
