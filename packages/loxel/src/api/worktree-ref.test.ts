import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";

import {
  formatWorktreeRef,
  isWorktreeRef,
  parseWorktreeRef,
  sameOptionalWorktreeRef,
  sameWorktreeRef,
  toServerId,
  worktreeRef,
} from "./worktree-ref";

const SERVER = toServerId("0b9f6c1e-5b1a-4c55-9a43-2f1d8f0e7a10");
const REF = worktreeRef(SERVER, "/home/u/repo/.worktrees/a");

describe("WorktreeRef", () => {
  test("round-trips through its string form", () => {
    expect<string>(formatWorktreeRef(REF)).toBe(`${SERVER}:/home/u/repo/.worktrees/a`);
    expect(parseWorktreeRef(formatWorktreeRef(REF))).toEqual(REF);
  });

  test("keeps a path's own colons", () => {
    const ref = worktreeRef(SERVER, "C:/Users/u/repo");
    expect(parseWorktreeRef(formatWorktreeRef(ref))).toEqual(ref);
  });

  test("parses only what it could have written", () => {
    expect(parseWorktreeRef("/no/server")).toBeNull();
    expect(parseWorktreeRef(":/no/server")).toBeNull();
    expect(parseWorktreeRef(`${SERVER}:`)).toBeNull();
    expect(parseWorktreeRef("/repo/a:b")).toBeNull();
  });

  test("is equal by server and path", () => {
    expect(sameWorktreeRef(REF, worktreeRef(SERVER, REF.path))).toBe(true);
    expect(sameWorktreeRef(REF, worktreeRef(toServerId("other"), REF.path))).toBe(false);
    expect(sameWorktreeRef(REF, worktreeRef(SERVER, "/home/u/repo"))).toBe(false);
  });

  test("is equal as an optional ref only to the same ref, or null to null", () => {
    expect(sameOptionalWorktreeRef(null, null)).toBe(true);
    expect(sameOptionalWorktreeRef(REF, null)).toBe(false);
    expect(sameOptionalWorktreeRef(null, REF)).toBe(false);
    expect(sameOptionalWorktreeRef(REF, worktreeRef(SERVER, REF.path))).toBe(true);
    expect(sameOptionalWorktreeRef(REF, worktreeRef(toServerId("other"), REF.path))).toBe(false);
  });

  test("recognizes a ref among untyped data", () => {
    expect(isWorktreeRef(JSON.parse(JSON.stringify(REF)))).toBe(true);
    expect(isWorktreeRef(REF.path)).toBe(false);
    expect(isWorktreeRef({ path: REF.path })).toBe(false);
    expect(isWorktreeRef(null)).toBe(false);
  });

  test("refuses a server id its string form or a URI authority could not hold", () => {
    for (const id of ["", "a:b", "a/b", "user@host", "Upper-Case", "a b"]) {
      expect(() => toServerId(id)).toThrow("Not a server id");
    }
  });

  test("accepts the IDs servers generate", () => {
    expect(toServerId(randomUUID())).toBeDefined();
  });

  test("parses a key whose server part is no server id as no ref", () => {
    expect(parseWorktreeRef("Upper:/repo")).toBeNull();
  });
});
