import { afterEach, describe, expect, test } from "bun:test";

import { executeAdd, executeInit } from "../lib/index.ts";
import { createTestRepo, runCli, type TestRepo } from "../test-repo.ts";

let repo: TestRepo;

afterEach(() => repo.cleanup());

/** A bare repo with metadata on and worktrees `a` and `b`. */
async function setup(): Promise<{ a: string; b: string }> {
  repo = await createTestRepo({ bare: true });
  await executeInit(repo.root, { apply: ["worktree-metadata-on"] });
  const a = await executeAdd({ name: "a", repoPath: repo.root });
  const b = await executeAdd({ name: "b", repoPath: repo.root });
  return { a: a.path, b: b.path };
}

describe("wt meta", () => {
  test("set, get and unset by name", async () => {
    await setup();

    const set = await runCli(["meta", "set", "a", "Color=red", "size=2", "-j"], repo.root);
    expect(set.exitCode).toBe(0);
    expect(set.json).toMatchObject({ name: "a", meta: { color: "red", size: "2" } });

    expect((await runCli(["meta", "get", "a", "color", "-j"], repo.root)).json).toMatchObject({
      name: "a",
      key: "color",
      value: "red",
    });
    expect((await runCli(["meta", "get", "a", "missing", "-j"], repo.root)).json).toMatchObject({
      value: null,
    });

    const unset = await runCli(["meta", "unset", "a", "color", "-j"], repo.root);
    expect(unset.json).toEqual({
      name: "a",
      path: expect.any(String),
      meta: { "wt-id": expect.any(String), size: "2" },
    });
  });

  test("without a name, acts on the worktree holding the cwd", async () => {
    const { a } = await setup();

    await runCli(["meta", "set", "k=v", "-j"], a);
    expect((await runCli(["meta", "get", "-j"], a)).json).toMatchObject({
      name: "a",
      meta: { k: "v" },
    });
    // A single argument is a key, unless a worktree has that name.
    expect((await runCli(["meta", "get", "k", "-j"], a)).json).toMatchObject({ value: "v" });
    expect((await runCli(["meta", "get", "b", "-j"], a)).json).toMatchObject({ name: "b" });

    await runCli(["meta", "unset", "k", "-j"], a);
    expect((await runCli(["meta", "get", "a", "-j"], repo.root)).json).toEqual({
      name: "a",
      path: a,
      meta: { "wt-id": expect.any(String) },
    });
  });

  test("from the main worktree, targets it even when a managed worktree has its name", async () => {
    repo = await createTestRepo();
    await executeInit(repo.root, { apply: ["worktree-metadata-on"] });
    const main = repo.root.split("/").at(-1) ?? "";
    const namesake = await executeAdd({ name: main, repoPath: repo.root });

    expect((await runCli(["meta", "set", "k=main", "-j"], repo.root)).json).toMatchObject({
      path: repo.root,
      meta: { k: "main" },
    });
    expect((await runCli(["meta", "get", "-j"], namesake.path)).json).toEqual({
      name: main,
      path: namesake.path,
      meta: { "wt-id": expect.any(String) },
    });
  });

  test("errors name the problem", async () => {
    await setup();
    const error = async (args: string[]) => {
      const { exitCode, json } = await runCli([...args, "-j"], repo.root);
      expect(exitCode).toBe(1);
      return (json as { message: string }).message;
    };

    expect(await error(["meta", "set", "a", "wt-id=x"])).toContain("reserved");
    expect(await error(["meta", "set", "a", "bad_key=x"])).toContain("Invalid metadata key");
    expect(await error(["meta", "get", "feat/typo"])).toContain("Worktree 'feat/typo' not found");
    // Outside every worktree and without a terminal, the name is required.
    expect(await error(["meta", "get"])).toContain("Usage: wt meta get [name] [key]");
    expect(await error(["meta", "set", "a"])).toContain("Usage: wt meta set");
    expect(await error(["meta", "get", "typo"])).toContain("No worktree is named 'typo'");
  });

  test("writes fail with metadata off; reads are empty", async () => {
    repo = await createTestRepo({ bare: true });
    await executeAdd({ name: "a", repoPath: repo.root });

    const set = await runCli(["meta", "set", "a", "k=v", "-j"], repo.root);
    expect(set.exitCode).toBe(1);
    expect(set.json).toMatchObject({
      message: expect.stringContaining("wt init --worktree-metadata on"),
    });
    expect((await runCli(["meta", "get", "a", "-j"], repo.root)).json).toMatchObject({ meta: {} });
  });
});

describe("metadata in other commands", () => {
  test("add --meta is repeatable, and list and view report meta", async () => {
    repo = await createTestRepo({ bare: true });
    await executeInit(repo.root, { apply: ["worktree-metadata-on"] });

    const added = await runCli(
      ["add", "c", "--meta", "loxel-parent-wt=p1", "--meta", "note=x=y", "-j"],
      repo.root,
    );
    expect(added.exitCode).toBe(0);
    const meta = { "wt-id": expect.any(String), "loxel-parent-wt": "p1", note: "x=y" };
    expect(added.json).toMatchObject({ name: "c", meta });

    expect((await runCli(["list", "-j"], repo.root)).json).toMatchObject({
      worktrees: [{ name: "c", meta }],
    });
    expect((await runCli(["view", "c", "-j"], repo.root)).json).toMatchObject({ name: "c", meta });
  });
});
