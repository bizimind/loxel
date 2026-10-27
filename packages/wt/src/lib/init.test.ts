import { afterEach, describe, expect, test } from "bun:test";
import { rename, rm } from "node:fs/promises";
import { join } from "node:path";

import { git, gitSucceeds, pathExists, runGit } from "../git/index.ts";
import {
  createTestDirectory,
  createTestRepo,
  enableOriginTracking,
  seedPath,
  type TestRepo,
} from "../test-repo.ts";
import { executeAdd } from "./add.ts";
import { evaluate, inspectRepo, type CheckId } from "./checks.ts";
import { cloneBareRepo, diagnose, executeInit, planInit } from "./init.ts";

let repo: TestRepo;
const previousWtDir = process.env.WT_DIR;

afterEach(async () => {
  if (previousWtDir === undefined) delete process.env.WT_DIR;
  else process.env.WT_DIR = previousWtDir;
  await repo.cleanup();
});

function statusOf(checks: Array<{ id: CheckId; status: string }>, id: CheckId): string | undefined {
  return checks.find((check) => check.id === id)?.status;
}

describe("diagnose", () => {
  test("flags a plain bare clone's missing refspec and default-branch worktree", async () => {
    repo = await createTestRepo({ bare: true });
    const diagnosis = await diagnose(repo.root);

    expect(diagnosis.bare).toBe(true);
    expect(diagnosis.ok).toBe(true);
    expect(statusOf(diagnosis.checks, "layout")).toBe("ok");
    expect(diagnosis.checks.find((c) => c.id === "fetch-refspec")).toMatchObject({
      status: "warn",
      fixable: true,
    });
    // origin/HEAD cannot exist without the refspec, so it is not checked separately.
    expect(statusOf(diagnosis.checks, "origin-head")).toBeUndefined();
    expect(statusOf(diagnosis.checks, "main-worktree")).toBe("info");
    expect(statusOf(diagnosis.checks, "worktree-metadata")).toBe("info");
  });

  test("is clean for a fully set-up bare repo", async () => {
    repo = await createTestRepo({ bare: true });
    await enableOriginTracking(repo.root);
    await executeAdd({ name: "main", repoPath: repo.root, branch: "main" });

    const { checks } = await diagnose(repo.root);
    const notOk = checks.filter((check) => check.status !== "ok").map((check) => check.id);
    expect(notOk).toEqual(["worktree-metadata"]);
  });

  test("reports a regular repo's layout as info and skips the main-worktree check", async () => {
    repo = await createTestRepo();
    const { checks, bare } = await diagnose(repo.root);

    expect(bare).toBe(false);
    expect(statusOf(checks, "layout")).toBe("info");
    expect(statusOf(checks, "fetch-refspec")).toBe("info");
    expect(statusOf(checks, "main-worktree")).toBeUndefined();
  });

  test("fails when per-worktree config is on but core.bare was left shared", async () => {
    repo = await createTestRepo({ bare: true });
    await git(["config", "extensions.worktreeConfig", "true"], repo.root);

    const diagnosis = await diagnose(repo.root);
    expect(diagnosis.ok).toBe(false);
    expect(statusOf(diagnosis.checks, "worktree-metadata")).toBe("fail");
  });

  test("reports WT_DIR, a legacy wt.yaml, hooks, and stale and locked worktrees", async () => {
    repo = await createTestRepo({ bare: true });
    process.env.WT_DIR = join(repo.root, "trees");
    await Bun.write(join(repo.root, "wt.yaml"), "worktrees_dir: x\n");
    await Bun.write(join(repo.root, "init.wt.sh"), "true\n");
    const gone = await executeAdd({ name: "gone", repoPath: repo.root });
    await rm(gone.path, { recursive: true });
    const held = await executeAdd({ name: "held", repoPath: repo.root });
    await git(["worktree", "lock", held.path], repo.root);

    const { checks } = await diagnose(repo.root);
    expect(statusOf(checks, "wt-dir")).toBe("info");
    expect(statusOf(checks, "legacy-config")).toBe("warn");
    expect(checks.find((c) => c.id === "hooks")?.summary).toBe("init.wt.sh");
    expect(checks.find((c) => c.id === "stale-worktrees")).toMatchObject({
      status: "warn",
      fixable: true,
    });
    expect(checks.find((c) => c.id === "locked-worktrees")).toMatchObject({
      status: "info",
      summary: held.path,
    });
  });

  test("fails on a git older than wt supports", async () => {
    repo = await createTestRepo();
    const state = await inspectRepo(repo.root);
    const { checks } = evaluate({ ...state, gitVersion: "2.30.9" });
    expect(statusOf(checks, "git-version")).toBe("fail");
  });
});

describe("planInit", () => {
  test("proposes actions as plain data with their exact commands", async () => {
    repo = await createTestRepo({ bare: true });
    const plan = await planInit(repo.root);

    const refspec = plan.actions.find((action) => action.id === "fetch-refspec");
    expect(refspec).toEqual({
      id: "fetch-refspec",
      check: "fetch-refspec",
      title: expect.any(String),
      recommended: true,
      recommendation: expect.any(String),
      tradeoffs: expect.any(Array),
      commands: [
        "git config remote.origin.fetch '+refs/heads/*:refs/remotes/origin/*'",
        "git fetch origin",
        "git remote set-head origin --auto  # if origin has branches",
      ],
    });
    expect(JSON.parse(JSON.stringify(plan))).toEqual(plan);
  });

  test("never recommends turning per-worktree config on", async () => {
    repo = await createTestRepo({ bare: true });
    const plan = await planInit(repo.root);

    const metadata = plan.actions.find((action) => action.id === "worktree-metadata-on");
    expect(metadata?.recommended).toBe(false);
    expect(metadata?.commands).toEqual([
      "git config --file config.worktree --replace-all core.bare true",
      "git config --file config --unset-all core.bare",
      "git config --file config extensions.worktreeConfig true",
    ]);
    expect(plan.actions.some((action) => action.id === "worktree-metadata-off")).toBe(false);
  });

  test("offers both repairs, recommending to keep it on, when the config is broken", async () => {
    repo = await createTestRepo({ bare: true });
    await git(["config", "extensions.worktreeConfig", "true"], repo.root);
    const plan = await planInit(repo.root);

    const metadata = plan.actions.filter((action) => action.check === "worktree-metadata");
    expect(metadata.map((action) => [action.id, action.recommended])).toEqual([
      ["worktree-metadata-on", true],
      ["worktree-metadata-off", false],
    ]);
  });
});

describe("executeInit", () => {
  test("changes nothing when no action is decided", async () => {
    repo = await createTestRepo({ bare: true });
    const config = await Bun.file(join(repo.root, "config")).text();

    const result = await executeInit(repo.root, { apply: [] });
    expect(result.outcomes).toEqual([]);
    expect(await Bun.file(join(repo.root, "config")).text()).toBe(config);
  });

  test("adds the refspec, fetches and records origin/HEAD, then reports it done", async () => {
    repo = await createTestRepo({ bare: true });
    const logs: string[] = [];
    const progress = { log: (m: string) => logs.push(m), warn: (m: string) => logs.push(m) };

    const result = await executeInit(
      repo.root,
      { apply: ["fetch-refspec", "origin-head"] },
      progress,
    );
    expect(result.outcomes.map((o) => [o.id, o.status])).toEqual([
      ["fetch-refspec", "applied"],
      ["origin-head", "not-needed"],
    ]);
    expect(await git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], repo.root)).toBe(
      "origin/main",
    );
    // Each command is printed before it runs.
    expect(logs).toContain("  $ git fetch origin");
    expect(statusOf(result.checks, "fetch-refspec")).toBe("ok");
    expect(statusOf(result.checks, "origin-head")).toBe("ok");

    const again = await executeInit(repo.root, { apply: ["fetch-refspec"] });
    expect(again.outcomes).toEqual([{ id: "fetch-refspec", status: "not-needed", commands: [] }]);
    expect(await git(["config", "--get-all", "remote.origin.fetch"], repo.root)).toBe(
      "+refs/heads/*:refs/remotes/origin/*",
    );
  });

  test("records a missing origin/HEAD", async () => {
    repo = await createTestRepo({ bare: true });
    await enableOriginTracking(repo.root);
    await git(["symbolic-ref", "--delete", "refs/remotes/origin/HEAD"], repo.root);
    expect(statusOf((await diagnose(repo.root)).checks, "origin-head")).toBe("info");

    const result = await executeInit(repo.root, { apply: ["origin-head"] });
    expect(result.outcomes[0]?.status).toBe("applied");
    expect(statusOf(result.checks, "origin-head")).toBe("ok");
  });

  test("fetches before recording origin/HEAD when only other branches were fetched", async () => {
    repo = await createTestRepo({ bare: true });
    await git(["branch", "other"], seedPath(repo.root));
    await git(["config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"], repo.root);
    await git(
      ["fetch", "--quiet", "origin", "+refs/heads/other:refs/remotes/origin/other"],
      repo.root,
    );
    await git(["symbolic-ref", "--delete", "refs/remotes/origin/HEAD"], repo.root).catch(() => "");
    expect(statusOf((await diagnose(repo.root)).checks, "origin-head")).toBe("warn");

    const result = await executeInit(repo.root, { apply: ["origin-head"] });
    expect(result.outcomes[0]).toMatchObject({
      status: "applied",
      commands: ["git fetch origin", "git remote set-head origin --auto  # if origin has branches"],
    });
    expect(statusOf(result.checks, "origin-head")).toBe("ok");
  });

  test("checks out the default branch as the first worktree", async () => {
    repo = await createTestRepo({ bare: true });
    const result = await executeInit(repo.root, { apply: ["main-worktree"] });

    expect(result.outcomes[0]).toEqual({
      id: "main-worktree",
      status: "applied",
      commands: ["wt add main -b main"],
    });
    const main = join(repo.root, ".worktrees", "main");
    expect(await git(["rev-parse", "--abbrev-ref", "HEAD"], main)).toBe("main");
    expect(statusOf(result.checks, "main-worktree")).toBe("ok");
  });

  test("prunes stale worktrees before re-creating the default branch's", async () => {
    repo = await createTestRepo({ bare: true });
    const stale = await executeAdd({ name: "main", repoPath: repo.root, branch: "main" });
    await rm(stale.path, { recursive: true });

    const result = await executeInit(repo.root, { apply: ["main-worktree", "prune-worktrees"] });
    expect(result.outcomes.map((o) => [o.id, o.status])).toEqual([
      ["prune-worktrees", "applied"],
      ["main-worktree", "applied"],
    ]);
    expect(await pathExists(stale.path)).toBe(true);
    expect(statusOf(result.checks, "stale-worktrees")).toBe("ok");
  });

  test("reconnects worktrees of a moved repository instead of pruning them", async () => {
    repo = await createTestRepo({ bare: true });
    await executeAdd({ name: "main", repoPath: repo.root, branch: "main" });
    await executeAdd({ name: "feat/x", repoPath: repo.root });
    const gone = await executeAdd({ name: "gone", repoPath: repo.root });
    await rm(gone.path, { recursive: true });
    const moved = join(repo.root, "..", "moved.git");
    await rename(repo.root, moved);

    const plan = await planInit(moved);
    expect(statusOf(plan.checks, "moved-worktrees")).toBe("warn");
    expect(plan.checks.find((c) => c.id === "stale-worktrees")?.summary).toContain("/gone");
    expect(plan.checks.find((c) => c.id === "stale-worktrees")?.summary).not.toContain("feat");
    // The moved main checkout still counts; adding another would collide with it.
    expect(statusOf(plan.checks, "main-worktree")).toBe("ok");
    expect(plan.actions.find((a) => a.id === "repair-worktrees")).toMatchObject({
      recommended: true,
      commands: [
        `git worktree repair ${join(moved, ".worktrees", "feat", "x")} ${join(moved, ".worktrees", "main")}`,
      ],
    });

    // Pruning alone must not cost the moved worktrees: it reconnects them first.
    const pruned = await executeInit(moved, { apply: ["prune-worktrees"] });
    expect(pruned.outcomes[0]?.status).toBe("applied");
    expect(
      await git(["rev-parse", "--abbrev-ref", "HEAD"], join(moved, ".worktrees", "feat", "x")),
    ).toBe("feat/x");
    const notOk = pruned.checks.filter((c) => c.status !== "ok").map((c) => c.id);
    expect(notOk).toEqual(["fetch-refspec", "worktree-metadata"]);
  });

  test("repairs moved worktrees on their own", async () => {
    repo = await createTestRepo({ bare: true });
    await executeAdd({ name: "feat", repoPath: repo.root });
    const moved = join(repo.root, "..", "moved.git");
    await rename(repo.root, moved);

    const result = await executeInit(moved, { apply: ["repair-worktrees"] });
    expect(result.outcomes[0]?.status).toBe("applied");
    await git(["status"], join(moved, ".worktrees", "feat"));
    expect(statusOf(result.checks, "moved-worktrees")).toBeUndefined();
    expect(statusOf(result.checks, "stale-worktrees")).toBe("ok");
  });

  test("leaves per-worktree config off unless it is explicitly decided", async () => {
    repo = await createTestRepo({ bare: true });
    const everythingElse = [
      "fetch-refspec",
      "origin-head",
      "prune-worktrees",
      "main-worktree",
    ] as const;
    await executeInit(repo.root, { apply: [...everythingElse] });

    expect(await gitSucceeds(["config", "--get", "extensions.worktreeConfig"], repo.root)).toBe(
      false,
    );
  });

  test("turns worktree metadata on and off, keeping linked worktrees usable", async () => {
    repo = await createTestRepo({ bare: true });
    const linked = await executeAdd({ name: "feat", repoPath: repo.root });

    const on = await executeInit(repo.root, { apply: ["worktree-metadata-on"] });
    expect(on.outcomes[0]?.status).toBe("applied");
    expect(statusOf(on.checks, "worktree-metadata")).toBe("ok");
    await git(["config", "--worktree", "wt.parent", "main"], linked.path);
    await git(["status"], linked.path);

    const repeat = await executeInit(repo.root, { apply: ["worktree-metadata-on"] });
    expect(repeat.outcomes[0]?.status).toBe("not-needed");

    const plan = await planInit(repo.root);
    const off = plan.actions.find((action) => action.id === "worktree-metadata-off");
    expect(off?.tradeoffs.join("\n")).toContain("wt.parent");

    const disabled = await executeInit(repo.root, { apply: ["worktree-metadata-off"] });
    expect(disabled.outcomes[0]?.status).toBe("applied");
    expect(statusOf(disabled.checks, "worktree-metadata")).toBe("info");
    expect(await git(["rev-parse", "--is-bare-repository"], repo.root)).toBe("true");
    await git(["status"], linked.path);
  });

  test("repairs the broken state", async () => {
    repo = await createTestRepo({ bare: true });
    const linked = await executeAdd({ name: "feat", repoPath: repo.root });
    await git(["config", "extensions.worktreeConfig", "true"], repo.root);
    expect((await runGit(["status"], linked.path)).exitCode).not.toBe(0);

    const result = await executeInit(linked.path, { apply: ["worktree-metadata-on"] });
    expect(result.outcomes[0]?.status).toBe("applied");
    await git(["status"], linked.path);
  });

  test("reports a failed action and still runs the rest", async () => {
    repo = await createTestRepo({ bare: true });
    await git(["remote", "set-url", "origin", join(repo.root, "missing")], repo.root);

    const result = await executeInit(repo.root, { apply: ["fetch-refspec", "main-worktree"] });
    expect(result.outcomes.map((o) => [o.id, o.status])).toEqual([
      ["fetch-refspec", "failed"],
      ["main-worktree", "applied"],
    ]);
    expect(result.outcomes[0]?.commands.at(-1)).toBe("git fetch origin");
    expect(result.outcomes[0]?.error).toContain("git fetch origin");
  });

  test("rejects contradictory and unknown decisions", async () => {
    repo = await createTestRepo({ bare: true });
    await expect(
      executeInit(repo.root, { apply: ["worktree-metadata-on", "worktree-metadata-off"] }),
    ).rejects.toThrow("both on and off");
    await expect(
      // @ts-expect-error: an id from untyped input
      executeInit(repo.root, { apply: ["convert-to-bare"] }),
    ).rejects.toThrow("Unknown init action");
  });
});

describe("cloneBareRepo", () => {
  test("creates a bare clone with origin tracking and a main worktree", async () => {
    repo = await createTestRepo();
    const target = await createTestDirectory();
    try {
      const result = await cloneBareRepo({ url: repo.root, dir: "proj", cwd: target.root });

      const root = join(target.root, "proj");
      expect(result.root).toBe(root);
      expect(result.bare).toBe(true);
      expect(result.outcomes.map((o) => [o.id, o.status])).toEqual([
        ["fetch-refspec", "applied"],
        ["main-worktree", "applied"],
      ]);
      expect(
        await git(["rev-parse", "--abbrev-ref", "HEAD"], join(root, ".worktrees", "main")),
      ).toBe("main");
      const notOk = result.checks.filter((c) => c.status !== "ok").map((c) => c.id);
      expect(notOk).toEqual(["worktree-metadata"]);
    } finally {
      await target.cleanup();
    }
  });

  test("sets up a clone of an empty repository without failing", async () => {
    repo = await createTestRepo();
    const empty = join(repo.root, "..", "empty.git");
    await git(["init", "--bare", empty], repo.root);
    const target = await createTestDirectory();
    try {
      const result = await cloneBareRepo({ url: empty, dir: "e", cwd: target.root });
      expect(result.outcomes.map((o) => [o.id, o.status])).toEqual([
        ["fetch-refspec", "applied"],
        ["main-worktree", "not-needed"],
      ]);
    } finally {
      await target.cleanup();
    }
  });

  test("applies only the actions it is given", async () => {
    repo = await createTestRepo();
    const target = await createTestDirectory();
    try {
      const result = await cloneBareRepo({
        url: repo.root,
        dir: "proj",
        cwd: target.root,
        apply: ["fetch-refspec"],
      });
      expect(result.outcomes.map((o) => o.id)).toEqual(["fetch-refspec"]);
      expect(await pathExists(join(target.root, "proj", ".worktrees"))).toBe(false);
    } finally {
      await target.cleanup();
    }
  });
});
