import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { $ } from "bun";

import { getStatus } from "./status";
import type { TempRepo } from "./test-utils";
import { branch, checkoutBranch, commit, createRepo, stageFile, writeFile } from "./test-utils";

let template: TempRepo;

beforeAll(async () => {
  template = await createRepo();
  await commit(template.path, "init", { "existing.txt": "original\n" });
});

afterAll(() => template.cleanup());

describe("getStatus", () => {
  test.each([
    {
      name: "clean repo",
      mutate: async (_p: string) => {},
      counts: { staged: 0, unstaged: 0, untracked: 0, conflicted: 0 },
    },
    {
      name: "staged new file",
      mutate: async (p: string) => {
        await writeFile(p, "new.txt", "content");
        await stageFile(p, "new.txt");
      },
      counts: { staged: 1, unstaged: 0, untracked: 0, conflicted: 0 },
    },
    {
      name: "unstaged modification",
      mutate: async (p: string) => {
        await writeFile(p, "existing.txt", "changed\n");
      },
      counts: { staged: 0, unstaged: 1, untracked: 0, conflicted: 0 },
    },
    {
      name: "untracked file",
      mutate: async (p: string) => {
        await writeFile(p, "brand-new.txt", "x");
      },
      counts: { staged: 0, unstaged: 0, untracked: 1, conflicted: 0 },
    },
    {
      name: "staged + unstaged on same file",
      mutate: async (p: string) => {
        await writeFile(p, "existing.txt", "staged-change\n");
        await stageFile(p, "existing.txt");
        await writeFile(p, "existing.txt", "further-change\n");
      },
      counts: { staged: 1, unstaged: 1, untracked: 0, conflicted: 0 },
    },
  ])("$name", async ({ mutate, counts }) => {
    const repo = await template.copy();
    try {
      await mutate(repo.path);
      const status = await getStatus(repo.path);
      expect(status.staged).toHaveLength(counts.staged);
      expect(status.unstaged).toHaveLength(counts.unstaged);
      expect(status.untracked).toHaveLength(counts.untracked);
      expect(status.conflicted).toHaveLength(counts.conflicted);
    } finally {
      await repo.cleanup();
    }
  });

  test("reports correct branch name", async () => {
    const repo = await template.copy();
    try {
      const status = await getStatus(repo.path);
      expect(status.branch).toBe("main");
    } finally {
      await repo.cleanup();
    }
  });

  test("reports correct commit hash", async () => {
    const repo = await template.copy();
    try {
      const head = (await $`git -C ${repo.path} rev-parse HEAD`.text()).trim();
      const status = await getStatus(repo.path);
      expect(status.commit).toBe(head);
    } finally {
      await repo.cleanup();
    }
  });

  test("detects merge conflict", async () => {
    const repo = await createRepo();
    try {
      await commit(repo.path, "base", { "conflict.txt": "base\n" });
      await branch(repo.path, "other");
      await commit(repo.path, "other-change", { "conflict.txt": "other\n" });
      await checkoutBranch(repo.path, "main");
      await commit(repo.path, "main-change", { "conflict.txt": "main\n" });
      await $`git -C ${repo.path} merge other --no-commit`.nothrow().quiet();
      const status = await getStatus(repo.path);
      expect(status.conflicted.length).toBeGreaterThan(0);
      expect(status.conflicted[0]!.path).toBe("conflict.txt");
    } finally {
      await repo.cleanup();
    }
  });
});

describe("getStatus paths", () => {
  test("reports renames and unusual names verbatim", async () => {
    const repo = await createRepo();
    try {
      await commit(repo.path, "init", { "tracked name.txt": "a\n" });
      await $`git -C ${repo.path} mv ${"tracked name.txt"} ${"renamed ü.txt"}`.quiet();
      await writeFile(repo.path, 'new "q".txt', "b\n");

      const status = await getStatus(repo.path);

      expect(status.staged).toEqual([
        { path: "renamed ü.txt", oldPath: "tracked name.txt", status: "R" },
      ]);
      expect(status.untracked).toEqual(['new "q".txt']);
    } finally {
      await repo.cleanup();
    }
  });
});

/** Whether this git has the built-in fsmonitor daemon (macOS and Windows builds only). */
const hasBuiltinFsmonitor = (await $`git version --build-options`.text()).includes(
  "fsmonitor--daemon",
);

describe("getStatus and fsmonitor", () => {
  // Forcing `-c core.fsmonitor=true` left a persistent daemon behind for every git dir a status
  // touched, submodules included, and bought nothing under GIT_OPTIONAL_LOCKS=0.
  test.skipIf(!hasBuiltinFsmonitor)(
    "starts no fsmonitor daemon, in the repo or its submodules, unless git config asks",
    async () => {
      const sub = await createRepo();
      const repo = await createRepo();
      try {
        await commit(sub.path, "sub init", { "s.txt": "s\n" });
        await commit(repo.path, "init", { "a.txt": "a\n" });
        await $`git -C ${repo.path} -c protocol.file.allow=always submodule add -q ${sub.path} sub`.quiet();
        await commit(repo.path, "add submodule");
        await writeFile(repo.path, "sub/s.txt", "dirty\n");
        // A developer's global config may legitimately enable fsmonitor; nothing to assert then.
        const configured = await $`git -C ${repo.path} config --get core.fsmonitor`
          .nothrow()
          .text();
        if (configured.trim()) return;

        const status = await getStatus(repo.path);

        expect(status.unstaged.map((entry) => entry.path)).toEqual(["sub"]);
        const ipc = await $`find ${repo.path}/.git -name fsmonitor--daemon.ipc`.text();
        expect(ipc.trim()).toBe("");
      } finally {
        await $`git -C ${repo.path} fsmonitor--daemon stop`.nothrow().quiet();
        await $`git -C ${repo.path}/sub fsmonitor--daemon stop`.nothrow().quiet();
        await repo.cleanup();
        await sub.cleanup();
      }
    },
  );

  test("leaves a repository-configured fsmonitor in charge", async () => {
    const repo = await createRepo();
    try {
      await commit(repo.path, "init", { "a.txt": "a\n" });
      // A hook-based fsmonitor works on every platform. A command-line `-c core.fsmonitor=...`
      // would override it and the hook would never run.
      const marker = `${repo.path}/.git/hook-ran`;
      const hook = `${repo.path}/.git/fsmonitor-hook.sh`;
      await Bun.write(hook, `#!/bin/sh\necho ran >> "${marker}"\nexit 1\n`);
      await $`chmod +x ${hook}`.quiet();
      await $`git -C ${repo.path} config core.fsmonitor ${hook}`.quiet();

      await getStatus(repo.path);

      expect(await Bun.file(marker).exists()).toBe(true);
    } finally {
      await repo.cleanup();
    }
  });
});
