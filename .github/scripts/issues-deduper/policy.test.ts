import { describe, expect, test } from "bun:test";

import {
  checkRelations,
  commentText,
  mayCloseInFavorOf,
  plainText,
  sanitizeResult,
} from "./policy.ts";
import { MAX_RELATIONS, type Relation } from "./schema.ts";

function relation(related: number, overrides: Partial<Relation> = {}): Relation {
  return {
    related_issue: related,
    relationship: "related",
    confidence: "medium",
    reasoning: "both touch the sidebar",
    ...overrides,
  };
}

const known = new Set([3, 5, 8, 10, 12, 13, 14, 15, 16, 17]);

describe("checkRelations", () => {
  test("accepts relations to known issues", () => {
    const { accepted, rejected } = checkRelations(
      { issue_number: 10, relations: [relation(5), relation(12)] },
      10,
      known,
    );
    expect(accepted.map((r) => r.related_issue)).toEqual([5, 12]);
    expect(rejected).toEqual([]);
  });

  test("rejects a result for another issue", () => {
    expect(() => checkRelations({ issue_number: 9, relations: [] }, 10, known)).toThrow();
  });

  test("rejects an unknown issue, the issue itself and repeats", () => {
    const { accepted, rejected } = checkRelations(
      { issue_number: 10, relations: [relation(99), relation(10), relation(5), relation(5)] },
      10,
      known,
    );
    expect(accepted.map((r) => r.related_issue)).toEqual([5]);
    expect(rejected.map((r) => r.reason)).toEqual([
      "not a known issue",
      "points at the issue itself",
      "repeats an earlier relation",
    ]);
  });

  test.each(["duplicate", "subset"] as const)("rejects a %s of a newer issue", (relationship) => {
    const { accepted } = checkRelations(
      {
        issue_number: 10,
        relations: [relation(12, { relationship }), relation(8, { relationship })],
      },
      10,
      known,
    );
    expect(accepted.map((r) => r.related_issue)).toEqual([8]);
  });

  test(`acts on at most ${MAX_RELATIONS} relations`, () => {
    const relations = [3, 5, 8, 12, 13, 14, 15].map((n) => relation(n));
    const { accepted } = checkRelations({ issue_number: 10, relations }, 10, known);
    expect(accepted).toHaveLength(MAX_RELATIONS);
  });
});

describe("plainText", () => {
  test("keeps short prose", () => {
    expect(plainText("same dark mode toggle request", 120)).toBe("same dark mode toggle request");
  });

  test("joins lines and drops backticks and control characters", () => {
    expect(plainText("first line\n\nsecond `code`\u0007 line", 120)).toBe(
      "first line second code line",
    );
  });

  test("removes links", () => {
    expect(plainText("see https://example.com/x and www.example.org now", 120)).toBe(
      "see (link removed) and (link removed) now",
    );
  });

  test("clips long text", () => {
    const text = plainText("word ".repeat(50), 20);
    expect(text).toHaveLength(20);
    expect(text?.endsWith("…")).toBe(true);
  });

  test.each([
    ["a long encoded run", `value ${"QUJD".repeat(10)}`],
    ["a token prefix", "ghs_abc123"],
    ["nothing but whitespace", " \n\t "],
  ])("drops text with %s", (_, text) => {
    expect(plainText(text, 300)).toBeNull();
  });
});

describe("commentText", () => {
  test("renders as an inline code span", () => {
    expect(commentText("cc @someone about #12", 120)).toBe("`cc @someone about #12`");
  });

  test("returns null for missing text", () => {
    expect(commentText(undefined, 120)).toBeNull();
  });
});

describe("sanitizeResult", () => {
  test("cleans free text and drops relations past the limit", () => {
    const relations = Array.from({ length: MAX_RELATIONS + 2 }, (_, i) =>
      relation(i + 1, { reasoning: "line one\nline two", unique_value: "see https://x.y/z" }),
    );
    const result = sanitizeResult({ issue_number: 10, relations });
    expect(result.relations).toHaveLength(MAX_RELATIONS);
    expect(result.relations[0]).toEqual({
      related_issue: 1,
      relationship: "related",
      confidence: "medium",
      reasoning: "line one line two",
      unique_value: "see (link removed)",
    });
  });

  test("leaves out unique_value it cannot keep", () => {
    const result = sanitizeResult({
      issue_number: 10,
      relations: [relation(5, { unique_value: "A".repeat(40) })],
    });
    expect(result.relations[0]).not.toHaveProperty("unique_value");
  });
});

describe("mayCloseInFavorOf", () => {
  test("allows an open issue filed by a member", () => {
    expect(mayCloseInFavorOf({ state: "open", author_association: "MEMBER" })).toBe(true);
  });

  test.each([
    ["a closed issue", { state: "closed", author_association: "OWNER" }],
    [
      "an issue filed by someone outside the project",
      { state: "open", author_association: "NONE" },
    ],
    ["a pull request", { state: "open", author_association: "OWNER", pull_request: {} }],
  ])("refuses %s", (_, record) => {
    expect(mayCloseInFavorOf(record)).toBe(false);
  });
});
