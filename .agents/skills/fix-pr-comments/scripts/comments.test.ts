import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const script = join(import.meta.dir, "comments.sh");

interface Author {
  login: string;
  __typename: "User" | "Bot";
}

function node(author: Author, association: string, extra: Record<string, unknown> = {}) {
  return { author, authorAssociation: association, ...extra };
}

const member: Author = { login: "maintainer", __typename: "User" };
const stranger: Author = { login: "stranger", __typename: "User" };
const reviewBot: Author = { login: "github-actions", __typename: "Bot" };

describe("comments.sh", () => {
  const bin = mkdtempSync(join(tmpdir(), "comments-sh-"));
  afterAll(() => rmSync(bin, { recursive: true, force: true }));

  const response = {
    data: {
      repository: {
        pullRequest: {
          reviewThreads: {
            nodes: [
              {
                id: "T1",
                isResolved: false,
                isOutdated: false,
                path: "a.ts",
                line: 3,
                comments: {
                  nodes: [
                    node(reviewBot, "CONTRIBUTOR", { databaseId: 1, url: "u1", body: "finding" }),
                    node(stranger, "NONE", { databaseId: 2, url: "u2", body: "outside reply" }),
                    node(member, "MEMBER", { databaseId: 3, url: "u3", body: "member reply" }),
                  ],
                },
              },
              {
                id: "T2",
                isResolved: false,
                isOutdated: false,
                path: "b.ts",
                line: 7,
                comments: {
                  nodes: [node(stranger, "NONE", { databaseId: 4, url: "u4", body: "outside" })],
                },
              },
              {
                id: "T3",
                isResolved: true,
                isOutdated: false,
                path: "c.ts",
                line: 1,
                comments: {
                  nodes: [node(member, "OWNER", { databaseId: 5, url: "u5", body: "x" })],
                },
              },
            ],
          },
          reviews: {
            nodes: [
              node(member, "OWNER", { url: "r1", state: "COMMENTED", body: "review body" }),
              node(stranger, "NONE", { url: "r2", state: "COMMENTED", body: "outside review" }),
              node(stranger, "NONE", { url: "r3", state: "COMMENTED", body: "" }),
            ],
          },
          comments: {
            nodes: [
              node(reviewBot, "CONTRIBUTOR", { url: "c1", body: "summary" }),
              node(stranger, "NONE", { url: "c2", body: "outside comment" }),
            ],
          },
        },
      },
    },
  };

  // A stand-in for gh that answers the two calls comments.sh makes.
  const responseFile = join(bin, "response.json");
  const fakeGh = join(bin, "gh");

  test("keeps the project's feedback and lists everyone else's as links only", async () => {
    await Bun.write(responseFile, JSON.stringify(response));
    await Bun.write(
      fakeGh,
      `#!/bin/sh\nif [ "$1" = repo ]; then echo owner/name; else cat "${responseFile}"; fi\n`,
    );
    chmodSync(fakeGh, 0o755);

    const result = Bun.spawnSync([script, "12"], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    });
    expect(result.stderr.toString()).toBe("");
    const output = JSON.parse(result.stdout.toString()) as unknown;

    expect(output).toEqual({
      threads: [
        {
          threadId: "T1",
          path: "a.ts",
          line: 3,
          isOutdated: false,
          commentId: 1,
          comments: [
            { author: "github-actions", body: "finding" },
            { author: "maintainer", body: "member reply" },
          ],
        },
      ],
      reviews: [{ author: "maintainer", state: "COMMENTED", url: "r1", body: "review body" }],
      comments: [{ author: "github-actions", url: "c1", body: "summary" }],
      outside: [
        { kind: "thread", author: "stranger", url: "u4" },
        { kind: "reply", author: "stranger", url: "u2" },
        { kind: "review", author: "stranger", url: "r2" },
        { kind: "comment", author: "stranger", url: "c2" },
      ],
    });
  });
});
