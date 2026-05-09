import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import type { TempRepo } from "./test-utils";

import {
  getCommitDiff,
  getRangeDiff,
  getStagedDiff,
  getUnstagedDiff,
  getWorkingTreeDiff,
} from "./diff";
import { commit, createRepo, deleteFile, renameFile, stageFile, writeFile } from "./test-utils";

/**
 * Template: single committed file "hello.txt" with content "hello\n".
 * Each test copies and mutates as needed.
 */
let template: TempRepo;
let initialHash: string;

beforeAll(async () => {
  template = await createRepo();
  initialHash = await commit(template.path, "init", { "hello.txt": "hello\n" });
});

afterAll(() => template.cleanup());

describe("getStagedDiff", () => {
  test("returns staged changes", async () => {
    const repo = await template.copy();
    try {
      await writeFile(repo.path, "hello.txt", "hello\nworld\n");
      await stageFile(repo.path, "hello.txt");
      const diff = await getStagedDiff(repo.path);
      expect(diff.files).toHaveLength(1);
      expect(diff.files[0]!.newPath).toBe("hello.txt");
      expect(diff.files[0]!.additions).toBeGreaterThan(0);
    } finally {
      await repo.cleanup();
    }
  });

  test("staged deletion", async () => {
    const repo = await template.copy();
    try {
      await deleteFile(repo.path, "hello.txt");
      await stageFile(repo.path, "hello.txt");
      const diff = await getStagedDiff(repo.path);
      expect(diff.files).toHaveLength(1);
      expect(diff.files[0]!.status).toBe("deleted");
      expect(diff.files[0]!.oldPath).toBe("hello.txt");
    } finally {
      await repo.cleanup();
    }
  });

  test("staged rename", async () => {
    const repo = await template.copy();
    try {
      await renameFile(repo.path, "hello.txt", "moved.txt");
      const diff = await getStagedDiff(repo.path);
      expect(diff.files).toHaveLength(1);
      expect(diff.files[0]!.status).toBe("renamed");
      expect(diff.files[0]!.oldPath).toBe("hello.txt");
      expect(diff.files[0]!.newPath).toBe("moved.txt");
    } finally {
      await repo.cleanup();
    }
  });

  test("returns empty for no staged changes", async () => {
    const repo = await template.copy();
    try {
      const diff = await getStagedDiff(repo.path);
      expect(diff.files).toHaveLength(0);
    } finally {
      await repo.cleanup();
    }
  });
});

describe("getUnstagedDiff", () => {
  test("returns unstaged changes", async () => {
    const repo = await template.copy();
    try {
      await writeFile(repo.path, "hello.txt", "modified\n");
      const diff = await getUnstagedDiff(repo.path);
      expect(diff.files).toHaveLength(1);
      expect(diff.files[0]!.newPath).toBe("hello.txt");
    } finally {
      await repo.cleanup();
    }
  });

  test("does not include untracked files", async () => {
    const repo = await template.copy();
    try {
      await writeFile(repo.path, "new-file.txt", "new");
      const diff = await getUnstagedDiff(repo.path);
      const paths = diff.files.map((f) => f.newPath);
      expect(paths).not.toContain("new-file.txt");
    } finally {
      await repo.cleanup();
    }
  });
});

describe("getCommitDiff", () => {
  test("added file", async () => {
    const repo = await template.copy();
    try {
      const hash = await commit(repo.path, "add file", { "extra.txt": "extra\n" });
      const diff = await getCommitDiff(repo.path, hash);
      expect(diff.files).toHaveLength(1);
      expect(diff.files[0]!.newPath).toBe("extra.txt");
      expect(diff.files[0]!.status).toBe("added");
      expect(diff.files[0]!.additions).toBe(1);
      expect(diff.files[0]!.deletions).toBe(0);
    } finally {
      await repo.cleanup();
    }
  });

  test("deleted file", async () => {
    const repo = await template.copy();
    try {
      await deleteFile(repo.path, "hello.txt");
      await stageFile(repo.path, "hello.txt");
      const hash = await commit(repo.path, "delete hello");
      const diff = await getCommitDiff(repo.path, hash);
      expect(diff.files).toHaveLength(1);
      expect(diff.files[0]!.oldPath).toBe("hello.txt");
      expect(diff.files[0]!.status).toBe("deleted");
      expect(diff.files[0]!.deletions).toBe(1);
      expect(diff.files[0]!.additions).toBe(0);
    } finally {
      await repo.cleanup();
    }
  });

  test("modified file reports additions and deletions", async () => {
    const repo = await template.copy();
    try {
      const hash = await commit(repo.path, "modify", { "hello.txt": "goodbye\nworld\n" });
      const diff = await getCommitDiff(repo.path, hash);
      expect(diff.files).toHaveLength(1);
      expect(diff.files[0]!.status).toBe("modified");
      expect(diff.files[0]!.additions).toBeGreaterThan(0);
      expect(diff.files[0]!.deletions).toBeGreaterThan(0);
    } finally {
      await repo.cleanup();
    }
  });

  test("rename shows as delete + add (diff-tree has no rename detection)", async () => {
    const repo = await template.copy();
    try {
      await renameFile(repo.path, "hello.txt", "greeting.txt");
      const hash = await commit(repo.path, "rename");
      const diff = await getCommitDiff(repo.path, hash);
      expect(diff.files).toHaveLength(2);
      expect(diff.files.find((f) => f.status === "deleted")!.oldPath).toBe("hello.txt");
      expect(diff.files.find((f) => f.status === "added")!.newPath).toBe("greeting.txt");
    } finally {
      await repo.cleanup();
    }
  });

  test("multiple files in one commit", async () => {
    const repo = await template.copy();
    try {
      const hash = await commit(repo.path, "multi", {
        "a.txt": "a\n",
        "b.txt": "b\n",
        "hello.txt": "updated\n",
      });
      const diff = await getCommitDiff(repo.path, hash);
      const paths = diff.files.map((f) => f.newPath);
      expect(paths).toContain("a.txt");
      expect(paths).toContain("b.txt");
      expect(paths).toContain("hello.txt");
      expect(diff.files.find((f) => f.newPath === "a.txt")!.status).toBe("added");
      expect(diff.files.find((f) => f.newPath === "b.txt")!.status).toBe("added");
      expect(diff.files.find((f) => f.newPath === "hello.txt")!.status).toBe("modified");
    } finally {
      await repo.cleanup();
    }
  });

  test("works for initial commit (root, no parent)", async () => {
    const repo = await createRepo();
    try {
      const hash = await commit(repo.path, "root", { "root.txt": "root\n" });
      const diff = await getCommitDiff(repo.path, hash);
      expect(diff.files).toHaveLength(1);
      expect(diff.files[0]!.newPath).toBe("root.txt");
    } finally {
      await repo.cleanup();
    }
  });
});

describe("getRangeDiff", () => {
  test("returns diff between two commits", async () => {
    const repo = await template.copy();
    try {
      const hash2 = await commit(repo.path, "second", { "second.txt": "2\n" });
      const diff = await getRangeDiff(repo.path, `${initialHash}..${hash2}`);
      expect(diff.files).toHaveLength(1);
      expect(diff.files[0]!.newPath).toBe("second.txt");
    } finally {
      await repo.cleanup();
    }
  });

  test("file added then deleted in range is not listed", async () => {
    const repo = await template.copy();
    try {
      await commit(repo.path, "add temp", { "temp.txt": "temp\n" });
      await deleteFile(repo.path, "temp.txt");
      await stageFile(repo.path, "temp.txt");
      const h2 = await commit(repo.path, "remove temp");
      const diff = await getRangeDiff(repo.path, `${initialHash}..${h2}`);
      const paths = diff.files.map((f) => f.newPath || f.oldPath);
      expect(paths).not.toContain("temp.txt");
    } finally {
      await repo.cleanup();
    }
  });

  test("deletion in range shows deleted status", async () => {
    const repo = await template.copy();
    try {
      await deleteFile(repo.path, "hello.txt");
      await stageFile(repo.path, "hello.txt");
      const h2 = await commit(repo.path, "delete hello");
      const diff = await getRangeDiff(repo.path, `${initialHash}..${h2}`);
      expect(diff.files).toHaveLength(1);
      expect(diff.files[0]!.status).toBe("deleted");
      expect(diff.files[0]!.oldPath).toBe("hello.txt");
    } finally {
      await repo.cleanup();
    }
  });

  test("rename across range", async () => {
    const repo = await template.copy();
    try {
      await renameFile(repo.path, "hello.txt", "renamed.txt");
      const h2 = await commit(repo.path, "rename");
      const diff = await getRangeDiff(repo.path, `${initialHash}..${h2}`);
      expect(diff.files).toHaveLength(1);
      expect(diff.files[0]!.status).toBe("renamed");
      expect(diff.files[0]!.oldPath).toBe("hello.txt");
      expect(diff.files[0]!.newPath).toBe("renamed.txt");
    } finally {
      await repo.cleanup();
    }
  });

  test("multi-commit range aggregates net changes", async () => {
    const repo = await template.copy();
    try {
      await commit(repo.path, "add a+b", { "a.txt": "a\n", "b.txt": "b\n" });
      await commit(repo.path, "modify a", { "a.txt": "a-updated\n" });
      const h3 = await commit(repo.path, "add c", { "c.txt": "c\n" });
      const diff = await getRangeDiff(repo.path, `${initialHash}..${h3}`);
      const paths = diff.files.map((f) => f.newPath);
      expect(paths).toContain("a.txt");
      expect(paths).toContain("b.txt");
      expect(paths).toContain("c.txt");
      // a.txt shows final state vs initial — only the net content matters
      const aFile = diff.files.find((f) => f.newPath === "a.txt")!;
      expect(aFile.status).toBe("added");
    } finally {
      await repo.cleanup();
    }
  });

  test("rejects invalid range format", async () => {
    const repo = await template.copy();
    try {
      await expect(getRangeDiff(repo.path, "not-a-range")).rejects.toThrow("Invalid range format");
    } finally {
      await repo.cleanup();
    }
  });
});

describe("getWorkingTreeDiff", () => {
  test("includes tracked and untracked files", async () => {
    const repo = await template.copy();
    try {
      await writeFile(repo.path, "hello.txt", "changed\n");
      await writeFile(repo.path, "untracked.txt", "new\n");
      const diff = await getWorkingTreeDiff(repo.path, repo.path);
      const paths = diff.files.map((f) => f.newPath);
      expect(paths).toContain("hello.txt");
      expect(paths).toContain("untracked.txt");
    } finally {
      await repo.cleanup();
    }
  });

  test("with base ref shows changes from that ref", async () => {
    const repo = await template.copy();
    try {
      await commit(repo.path, "second", { "second.txt": "2\n" });
      await writeFile(repo.path, "third.txt", "3\n");
      const diff = await getWorkingTreeDiff(repo.path, repo.path, initialHash);
      const paths = diff.files.map((f) => f.newPath);
      expect(paths).toContain("second.txt");
      expect(paths).toContain("third.txt");
    } finally {
      await repo.cleanup();
    }
  });
});
