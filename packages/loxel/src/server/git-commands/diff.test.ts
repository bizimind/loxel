import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmod, mkdir, symlink } from "node:fs/promises";
import path from "node:path";

import { $ } from "bun";

import { parseDiffOutput } from "../parsers/diff";
import {
  getCommitDiff,
  getRangeDiff,
  getStagedDiff,
  getUnstagedDiff,
  getWorkingTreeDiff,
} from "./diff";
import type { TempRepo } from "./test-utils";
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

describe("getWorkingTreeDiff untracked files", () => {
  /** The old implementation: one `git diff --no-index` per file, in `ls-files` order. */
  async function perFileDiffs(repoPath: string, files: string[]) {
    const diffs = [];
    for (const file of files) {
      const out = await $`git -C ${repoPath} diff --no-index -- /dev/null ${file}`.nothrow().text();
      diffs.push(...parseDiffOutput(out));
    }
    return diffs;
  }

  test("match per-file `git diff --no-index` output for every kind of file", async () => {
    const repo = await template.copy();
    try {
      const names = [
        ":colon.txt",
        "bin.dat",
        "empty.txt",
        "exec.sh",
        "link",
        "no-newline.txt",
        'q"uote.txt',
        "sp ace/f g.txt",
        "st*ar.txt",
        "text.txt",
        "ünï.txt",
      ];
      await writeFile(repo.path, "text.txt", "a\nb\n");
      await writeFile(repo.path, "no-newline.txt", "no newline");
      await writeFile(repo.path, "empty.txt", "");
      await Bun.write(path.join(repo.path, "bin.dat"), new Uint8Array([120, 0, 121]));
      await writeFile(repo.path, "exec.sh", "#!/bin/sh\n");
      await chmod(path.join(repo.path, "exec.sh"), 0o755);
      await symlink("text.txt", path.join(repo.path, "link"));
      for (const name of [":colon.txt", 'q"uote.txt', "sp ace/f g.txt", "st*ar.txt", "ünï.txt"]) {
        await writeFile(repo.path, name, `${name}\n`);
      }

      const diff = await getWorkingTreeDiff(repo.path, repo.path);

      expect(diff.files.map((file) => file.newPath)).toEqual(names);
      expect(diff.files).toEqual(await perFileDiffs(repo.path, names));
      expect(diff.files.find((file) => file.newPath === "bin.dat")?.isBinary).toBe(true);
    } finally {
      await repo.cleanup();
    }
  });

  test("leave nested repositories out, as before", async () => {
    const repo = await template.copy();
    try {
      await writeFile(repo.path, "nested/n.txt", "n\n");
      await $`git -C ${path.join(repo.path, "nested")} init -q`.quiet();
      await writeFile(repo.path, "new.txt", "x\n");

      const diff = await getWorkingTreeDiff(repo.path, repo.path);

      expect(diff.files.map((file) => file.newPath)).toEqual(["new.txt"]);
    } finally {
      await repo.cleanup();
    }
  });

  test("write nothing under the git dir", async () => {
    // A fresh commit rather than template.copy(): copying leaves stat-dirty index entries, and
    // porcelain `git diff` rewrites the index for those even under GIT_OPTIONAL_LOCKS=0 — a
    // one-off refresh of the tracked half, not what this test is about.
    const repo = await createRepo();
    try {
      await commit(repo.path, "init", { "hello.txt": "hello\n" });
      // The empty blob already existing is the case where `git add -N` would freshen it.
      await $`git -C ${repo.path} hash-object -w -t blob /dev/null`.quiet();
      await writeFile(repo.path, "new.txt", "x\n");
      const marker = path.join(repo.path, "marker");
      await Bun.write(marker, "");
      await Bun.sleep(1100); // mtime granularity on coarse filesystems

      await getWorkingTreeDiff(repo.path, repo.path);

      const touched = await $`find ${path.join(repo.path, ".git")} -newer ${marker}`.text();
      expect(touched.trim()).toBe("");
    } finally {
      await repo.cleanup();
    }
  });

  test("report tracked renames and non-ASCII names git quotes in diff headers", async () => {
    const repo = await createRepo();
    try {
      await commit(repo.path, "init", { "plain.txt": "a\n", "ünï.txt": "b\n" });
      await $`git -C ${repo.path} mv plain.txt ${'q"ü.txt'}`.quiet();
      await writeFile(repo.path, "ünï.txt", "b\nc\n");

      const diff = await getWorkingTreeDiff(repo.path, repo.path);

      expect(
        diff.files.map(({ oldPath, newPath, status }) => ({ oldPath, newPath, status })),
      ).toEqual([
        { oldPath: "plain.txt", newPath: 'q"ü.txt', status: "renamed" },
        { oldPath: "ünï.txt", newPath: "ünï.txt", status: "modified" },
      ]);
    } finally {
      await repo.cleanup();
    }
  });

  test("fall back to per-file diffs when git refuses to add the paths", async () => {
    const repo = await template.copy();
    try {
      await commit(repo.path, "dirs", { "in/a.txt": "a\n", "out/b.txt": "b\n" });
      await $`git -C ${repo.path} sparse-checkout set --cone in`.quiet();
      // Untracked, but outside the sparse cone: `git add` rejects it.
      await mkdir(path.join(repo.path, "out"), { recursive: true });
      await writeFile(repo.path, "out/new.txt", "outside\n");
      await writeFile(repo.path, "in/new.txt", "inside\n");

      const diff = await getWorkingTreeDiff(repo.path, repo.path);

      expect(diff.files.map((file) => file.newPath).sort()).toEqual(["in/new.txt", "out/new.txt"]);
    } finally {
      await repo.cleanup();
    }
  });
});

describe("resolved diff bases", () => {
  async function repoWithWorktree(): Promise<{
    repo: TempRepo;
    wtPath: string;
    wtHead: string;
    repoHead: string;
  }> {
    const repo = await template.copy();
    const wtPath = path.join(repo.path, ".worktrees", "feature");
    await $`git -C ${repo.path} worktree add -b feature ${wtPath}`.quiet();
    const wtHead = await commit(wtPath, "only on branch", { "only-on-branch.txt": "branch\n" });
    const repoHead = (await $`git -C ${repo.path} rev-parse HEAD`.text()).trim();
    return { repo, wtPath, wtHead, repoHead };
  }

  test("resolves a working-tree HEAD in that worktree", async () => {
    const { repo, wtPath, wtHead, repoHead } = await repoWithWorktree();
    try {
      await writeFile(wtPath, "only-on-branch.txt", "branch changed\n");
      const diff = await getWorkingTreeDiff(repo.path, wtPath);
      expect(diff.baseRef).toBe(wtHead);
      expect(diff.baseRef).not.toBe(repoHead);
    } finally {
      await repo.cleanup();
    }
  });

  test("reports an explicit working-tree base as a full SHA", async () => {
    const repo = await template.copy();
    try {
      await writeFile(repo.path, "hello.txt", "changed\n");
      expect(
        (await getWorkingTreeDiff(repo.path, repo.path, initialHash.slice(0, 8))).baseRef,
      ).toBe(initialHash);
    } finally {
      await repo.cleanup();
    }
  });

  test("reports a commit parent and null for a root commit", async () => {
    const repo = await template.copy();
    try {
      const second = await commit(repo.path, "second", { "second.txt": "2\n" });
      expect((await getCommitDiff(repo.path, second)).baseRef).toBe(initialHash);
      expect((await getCommitDiff(repo.path, initialHash)).baseRef).toBeNull();
    } finally {
      await repo.cleanup();
    }
  });

  test("uses the left commit for a two-dot range", async () => {
    const repo = await template.copy();
    try {
      const second = await commit(repo.path, "second", { "second.txt": "2\n" });
      expect((await getRangeDiff(repo.path, `${initialHash}..${second}`)).baseRef).toBe(
        initialHash,
      );
    } finally {
      await repo.cleanup();
    }
  });

  test("uses the merge base for a divergent three-dot range", async () => {
    const repo = await template.copy();
    try {
      await $`git -C ${repo.path} branch left ${initialHash}`.quiet();
      const right = await commit(repo.path, "right", { "right.txt": "right\n" });
      await $`git -C ${repo.path} switch left`.quiet();
      const left = await commit(repo.path, "left", { "left.txt": "left\n" });

      const diff = await getRangeDiff(repo.path, `${left}...${right}`);

      expect(diff.baseRef).toBe(initialHash);
      expect(diff.files.map((file) => file.newPath)).toEqual(["right.txt"]);
    } finally {
      await repo.cleanup();
    }
  });

  test("reports HEAD for staged changes and no commit base for unstaged changes", async () => {
    const repo = await template.copy();
    try {
      await writeFile(repo.path, "hello.txt", "hello\nstaged\n");
      await stageFile(repo.path, "hello.txt");
      expect((await getStagedDiff(repo.path)).baseRef).toBe(initialHash);
      expect((await getUnstagedDiff(repo.path)).baseRef).toBeNull();
    } finally {
      await repo.cleanup();
    }
  });
});
