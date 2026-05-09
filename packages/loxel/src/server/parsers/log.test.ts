import { describe, expect, test } from "bun:test";

import { parseLogOutput } from "./log";

describe("parseLogOutput", () => {
  test("parses commit with all fields", () => {
    const output = [
      "abc123def456789012345678901234567890abcd\x00parent123\x00Fix bug in parser\x00",
      "John Doe\x00john@example.com\x002024-01-15T10:30:00Z\x00",
      "Jane Smith\x00jane@example.com\x002024-01-15T10:35:00Z\x00HEAD -> main, origin/main",
    ].join("");

    const commits = parseLogOutput(output);

    expect(commits).toHaveLength(1);
    const commit = commits[0]!;
    expect(commit).toMatchObject({
      hash: "abc123def456789012345678901234567890abcd",
      shortHash: "abc123d",
      parents: ["parent123"],
      message: "Fix bug in parser",
      author: "John Doe",
      authorEmail: "john@example.com",
      committer: "Jane Smith",
    });
    expect(commit.refs).toHaveLength(3);
  });

  test("parses commit without refs", () => {
    const output = [
      "abc123def456789012345678901234567890abcd\x00parent1 parent2\x00Merge branch\x00",
      "John Doe\x00john@example.com\x002024-01-15T10:30:00Z\x00",
      "John Doe\x00john@example.com\x002024-01-15T10:30:00Z\x00",
    ].join("");

    const commits = parseLogOutput(output);

    expect(commits).toHaveLength(1);
    const commit = commits[0]!;
    expect(commit.parents).toEqual(["parent1", "parent2"]);
    expect(commit.refs).toEqual([]);
  });

  test("parses multiple commits", () => {
    const lines = [
      "hash1\x00\x00First commit\x00A\x00a@x.com\x002024-01-01\x00A\x00a@x.com\x002024-01-01\x00",
      "hash2\x00hash1\x00Second commit\x00B\x00b@x.com\x002024-01-02\x00B\x00b@x.com\x002024-01-02\x00",
    ].join("\n");

    const commits = parseLogOutput(lines);

    expect(commits).toHaveLength(2);
    expect(commits[0]!.hash).toBe("hash1");
    expect(commits[1]!.hash).toBe("hash2");
  });

  test("handles empty output", () => {
    expect(parseLogOutput("")).toEqual([]);
    expect(parseLogOutput("   ")).toEqual([]);
  });
});
