import { describe, expect, test } from "bun:test";

import type { PlacedThread } from "@/api/review-model";

import { threadsToMarkdown } from "./threads-to-markdown";

function makeThread(overrides: Partial<PlacedThread> = {}): PlacedThread {
  return {
    id: "thread-1",
    reviewId: "review-1",
    filePath: "src/server/routes.ts",
    createdSide: "new",
    contentAnchor: {
      content: ["const x = 1;"],
      contextBefore: [],
      contextAfter: [],
      contentHash: "abc123",
    },
    startLine: 10,
    endLine: 10,
    status: "open",
    createdAt: "2026-03-19T10:00:00Z",
    updatedAt: "2026-03-19T10:00:00Z",
    comments: [
      {
        id: "c1",
        threadId: "thread-1",
        body: "This needs validation.",
        authorName: "Alice",
        createdAt: "2026-03-19T10:00:00Z",
        updatedAt: "2026-03-19T10:00:00Z",
      },
    ],
    displaySide: "new",
    displayStartLine: 10,
    displayEndLine: 10,
    anchorStatus: "exact",
    ...overrides,
  };
}

describe("threadsToMarkdown", () => {
  test("empty state", () => {
    const result = threadsToMarkdown({
      reviewNames: [],
      placedThreadsByFile: new Map(),
      lostThreads: [],
    });
    expect(result).toContain("No comments.");
  });

  test("single file with one open thread", () => {
    const thread = makeThread();
    const result = threadsToMarkdown({
      reviewNames: ["My Review"],
      placedThreadsByFile: new Map([["src/server/routes.ts", [thread]]]),
      lostThreads: [],
    });

    expect(result).toContain("# Review Comments");
    expect(result).toContain("**Reviews:** My Review");
    expect(result).toContain("1 open");
    expect(result).toContain("1 file");
    expect(result).toContain("## `src/server/routes.ts`");
    expect(result).toContain("### Line 10 -- OPEN");
    expect(result).toContain("```typescript");
    expect(result).toContain("const x = 1;");
    expect(result).toContain("This needs validation.");
  });

  test("line range for multi-line thread", () => {
    const thread = makeThread({ displayStartLine: 42, displayEndLine: 55 });
    const result = threadsToMarkdown({
      reviewNames: [],
      placedThreadsByFile: new Map([["src/file.ts", [thread]]]),
      lostThreads: [],
    });
    expect(result).toContain("### Lines 42-55 -- OPEN");
  });

  test("resolved thread", () => {
    const thread = makeThread({ status: "resolved" });
    const result = threadsToMarkdown({
      reviewNames: [],
      placedThreadsByFile: new Map([["src/file.ts", [thread]]]),
      lostThreads: [],
    });
    expect(result).toContain("-- RESOLVED");
    expect(result).toContain("1 resolved");
  });

  test("open threads sorted before resolved", () => {
    const resolved = makeThread({
      id: "t1",
      status: "resolved",
      displayStartLine: 5,
      displayEndLine: 5,
    });
    const open = makeThread({ id: "t2", status: "open", displayStartLine: 20, displayEndLine: 20 });
    const result = threadsToMarkdown({
      reviewNames: [],
      placedThreadsByFile: new Map([["src/file.ts", [resolved, open]]]),
      lostThreads: [],
    });

    const openIdx = result.indexOf("OPEN");
    const resolvedIdx = result.indexOf("RESOLVED");
    expect(openIdx).toBeLessThan(resolvedIdx);
  });

  test("single author omits author names", () => {
    const thread = makeThread({
      comments: [
        {
          id: "c1",
          threadId: "t1",
          body: "First comment.",
          authorName: "Alice",
          createdAt: "2026-03-19T10:00:00Z",
          updatedAt: "2026-03-19T10:00:00Z",
        },
        {
          id: "c2",
          threadId: "t1",
          body: "Reply comment.",
          authorName: "Alice",
          createdAt: "2026-03-19T11:00:00Z",
          updatedAt: "2026-03-19T11:00:00Z",
        },
      ],
    });
    const result = threadsToMarkdown({
      reviewNames: [],
      placedThreadsByFile: new Map([["src/file.ts", [thread]]]),
      lostThreads: [],
    });

    // Should not contain author name
    expect(result).not.toContain("**Alice");
    // First comment as plain text
    expect(result).toContain("First comment.");
    // Reply as blockquote
    expect(result).toContain("> Reply comment.");
  });

  test("multi-author shows author names", () => {
    const thread = makeThread({
      comments: [
        {
          id: "c1",
          threadId: "t1",
          body: "First comment.",
          authorName: "Alice",
          createdAt: "2026-03-19T10:00:00Z",
          updatedAt: "2026-03-19T10:00:00Z",
        },
        {
          id: "c2",
          threadId: "t1",
          body: "Reply from Bob.",
          authorName: "Bob",
          createdAt: "2026-03-19T11:00:00Z",
          updatedAt: "2026-03-19T11:00:00Z",
        },
      ],
    });
    const result = threadsToMarkdown({
      reviewNames: [],
      placedThreadsByFile: new Map([["src/file.ts", [thread]]]),
      lostThreads: [],
    });

    expect(result).toContain("**Alice:**");
    expect(result).toContain("**Bob:**");
  });

  test("outdated anchor status", () => {
    const thread = makeThread({ anchorStatus: "outdated", originalContent: ["const old = true;"] });
    const result = threadsToMarkdown({
      reviewNames: [],
      placedThreadsByFile: new Map([["src/file.ts", [thread]]]),
      lostThreads: [],
    });

    expect(result).toContain("[outdated]");
    expect(result).toContain("code at this location has changed");
  });

  test("relocated anchor status", () => {
    const thread = makeThread({ anchorStatus: "relocated" });
    const result = threadsToMarkdown({
      reviewNames: [],
      placedThreadsByFile: new Map([["src/file.ts", [thread]]]),
      lostThreads: [],
    });

    expect(result).toContain("[relocated]");
  });

  test("lost threads section", () => {
    const lost = makeThread({ anchorStatus: "lost", filePath: "src/old.ts" });
    const result = threadsToMarkdown({
      reviewNames: [],
      placedThreadsByFile: new Map(),
      lostThreads: [lost],
    });

    expect(result).toContain("## Lost Comments");
    expect(result).toContain("could not be anchored");
    expect(result).toContain("`src/old.ts`");
  });

  test("language inference from file extension", () => {
    const pyThread = makeThread({ filePath: "script.py" });
    const result = threadsToMarkdown({
      reviewNames: [],
      placedThreadsByFile: new Map([["script.py", [pyThread]]]),
      lostThreads: [],
    });
    expect(result).toContain("```python");
  });

  test("multiple review names", () => {
    const thread = makeThread();
    const result = threadsToMarkdown({
      reviewNames: ["Review A", "Review B"],
      placedThreadsByFile: new Map([["src/file.ts", [thread]]]),
      lostThreads: [],
    });
    expect(result).toContain("**Reviews:** Review A, Review B");
  });

  test("multiple files sorted alphabetically", () => {
    const threadA = makeThread({ filePath: "src/z-file.ts" });
    const threadB = makeThread({ filePath: "src/a-file.ts" });
    const result = threadsToMarkdown({
      reviewNames: [],
      placedThreadsByFile: new Map([
        ["src/z-file.ts", [threadA]],
        ["src/a-file.ts", [threadB]],
      ]),
      lostThreads: [],
    });

    const aIdx = result.indexOf("`src/a-file.ts`");
    const zIdx = result.indexOf("`src/z-file.ts`");
    expect(aIdx).toBeLessThan(zIdx);
  });

  test("no timestamps in output", () => {
    const thread = makeThread();
    const result = threadsToMarkdown({
      reviewNames: [],
      placedThreadsByFile: new Map([["src/file.ts", [thread]]]),
      lostThreads: [],
    });

    expect(result).not.toContain("2026-03-19");
    expect(result).not.toContain("ago");
  });

  test("multiline reply as blockquote preserves lines", () => {
    const thread = makeThread({
      comments: [
        {
          id: "c1",
          threadId: "t1",
          body: "First.",
          authorName: "Alice",
          createdAt: "2026-03-19T10:00:00Z",
          updatedAt: "2026-03-19T10:00:00Z",
        },
        {
          id: "c2",
          threadId: "t1",
          body: "Line one.\nLine two.",
          authorName: "Alice",
          createdAt: "2026-03-19T11:00:00Z",
          updatedAt: "2026-03-19T11:00:00Z",
        },
      ],
    });
    const result = threadsToMarkdown({
      reviewNames: [],
      placedThreadsByFile: new Map([["src/file.ts", [thread]]]),
      lostThreads: [],
    });

    expect(result).toContain("> Line one.");
    expect(result).toContain("> Line two.");
  });
});
