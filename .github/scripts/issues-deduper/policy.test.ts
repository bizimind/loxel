import { describe, expect, test } from "bun:test";

import { checkRelations, commentText, MAX_RELATIONS, mayCloseInFavorOf } from "./policy.ts";
import type { Relation } from "./schema.ts";

function relation(related: number, overrides: Partial<Relation> = {}): Relation {
  return {
    related_issue: related,
    relationship: "related",
    confidence: "medium",
    reasoning: "both touch the sidebar",
    ...overrides,
  };
}

const known = new Set([3, 5, 8, 10, 12, 13, 14, 15]);
const related = (relations: Relation[]) =>
  checkRelations({ issue_number: 10, relations }, 10, known).map((r) => r.related_issue);

describe("checkRelations", () => {
  test("keeps relations to stored issues", () => {
    expect(related([relation(5), relation(12)])).toEqual([5, 12]);
  });

  test("rejects a result for another issue", () => {
    expect(() => checkRelations({ issue_number: 9, relations: [] }, 10, known)).toThrow();
  });

  test("drops an unknown issue, the issue itself and repeats", () => {
    expect(related([relation(99), relation(10), relation(5), relation(5)])).toEqual([5]);
  });

  test.each(["duplicate", "subset"] as const)("drops a %s of a newer issue", (relationship) => {
    expect(related([relation(12, { relationship }), relation(8, { relationship })])).toEqual([8]);
  });

  test(`keeps at most ${MAX_RELATIONS} relations`, () => {
    expect(related([3, 5, 8, 12, 13, 14, 15].map((n) => relation(n)))).toHaveLength(MAX_RELATIONS);
  });
});

describe("commentText", () => {
  test("renders one line as an inline code span", () => {
    expect(commentText("cc @someone\nabout `#12`", 120)).toBe("`cc @someone about #12`");
  });

  test("clips long text", () => {
    const text = commentText("word ".repeat(50), 20);
    expect(text).toHaveLength(22);
    expect(text?.endsWith("…`")).toBe(true);
  });

  test("returns null for missing or blank text", () => {
    expect(commentText(undefined, 120)).toBeNull();
    expect(commentText(" \n ", 120)).toBeNull();
  });
});

describe("mayCloseInFavorOf", () => {
  const open = { state: "open", isPullRequest: false };

  test.each(["admin", "write"])("allows an open issue filed by someone with %s access", (p) => {
    expect(mayCloseInFavorOf({ ...open, authorPermission: p })).toBe(true);
  });

  test.each([
    ["a closed issue", { ...open, state: "closed", authorPermission: "admin" }],
    ["an issue filed without write access", { ...open, authorPermission: "read" }],
    ["a pull request", { ...open, isPullRequest: true, authorPermission: "admin" }],
  ])("refuses %s", (_, record) => {
    expect(mayCloseInFavorOf(record)).toBe(false);
  });
});
