import { describe, expect, test } from "bun:test";

interface Author {
  login: string;
  __typename: "User" | "Bot";
}

function node(author: Author, association: string) {
  return { author, authorAssociation: association };
}

const member: Author = { login: "maintainer", __typename: "User" };
const stranger: Author = { login: "stranger", __typename: "User" };
const reviewBot: Author = { login: "github-actions", __typename: "Bot" };

function trusted(input: unknown): boolean {
  const result = Bun.spawnSync(["jq", "-L", import.meta.dir, 'include "trusted"; trusted'], {
    stdin: new TextEncoder().encode(JSON.stringify(input)),
  });
  expect(result.exitCode).toBe(0);
  return JSON.parse(result.stdout.toString()) as boolean;
}

describe("trusted.jq", () => {
  test.each(["OWNER", "MEMBER", "COLLABORATOR"])("trusts a %s", (association) => {
    expect(trusted(node(member, association))).toBe(true);
  });

  test.each(["CONTRIBUTOR", "FIRST_TIME_CONTRIBUTOR", "NONE"])(
    "does not trust a %s",
    (association) => {
      expect(trusted(node(stranger, association))).toBe(false);
    },
  );

  test("trusts the review bot", () => {
    expect(trusted(node(reviewBot, "CONTRIBUTOR"))).toBe(true);
  });

  test("does not trust a user account named like a review bot", () => {
    expect(trusted(node({ login: "github-actions", __typename: "User" }, "NONE"))).toBe(false);
  });

  test("does not trust a deleted author", () => {
    expect(trusted({ author: null, authorAssociation: "NONE" })).toBe(false);
  });
});
