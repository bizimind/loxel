import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";

import { git, gitSucceeds } from "../git/index.ts";
import { planInit } from "../lib/index.ts";
import { createTestRepo, type TestRepo } from "../test-repo.ts";
import { parseFlags, resolveDecisions, type InitOptions } from "./init.ts";

let repo: TestRepo;

afterEach(() => repo.cleanup());

const CLI = join(import.meta.dir, "..", "cli.ts");

/** Run the CLI with no terminal on stdin, as an agent or script would. */
async function runCli(args: string[], cwd: string): Promise<{ exitCode: number; json: unknown }> {
  const proc = Bun.spawn(["bun", CLI, ...args], {
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, , exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, json: JSON.parse(stdout) };
}

async function decide(options: InitOptions) {
  const plan = await planInit(repo.root);
  const { apply, undecided } = resolveDecisions(plan, parseFlags(options), options.yes ?? false);
  return { apply, undecided: undecided.map((decision) => decision.check.id) };
}

describe("resolveDecisions", () => {
  test("decides nothing without flags", async () => {
    repo = await createTestRepo({ bare: true });
    expect(await decide({})).toEqual({
      apply: [],
      undecided: ["fetch-refspec", "main-worktree", "worktree-metadata"],
    });
  });

  test("--yes applies the recommended actions, never turning on worktree metadata", async () => {
    repo = await createTestRepo({ bare: true });
    expect(await decide({ yes: true })).toEqual({
      apply: ["fetch-refspec", "main-worktree"],
      undecided: [],
    });
  });

  test("a --no- flag overrides --yes for its action", async () => {
    repo = await createTestRepo({ bare: true });
    expect(await decide({ yes: true, mainWorktree: false })).toEqual({
      apply: ["fetch-refspec"],
      undecided: [],
    });
  });

  test("flags decide their own checks and leave the rest undecided", async () => {
    repo = await createTestRepo({ bare: true });
    expect(await decide({ fetchRefspec: true, worktreeMetadata: "on" })).toEqual({
      apply: ["fetch-refspec", "worktree-metadata-on"],
      undecided: ["main-worktree"],
    });
  });

  test("a flag applies an action whose check is ok", async () => {
    repo = await createTestRepo({ bare: true });
    expect((await decide({ worktreeMetadata: "off" })).apply).toEqual(["worktree-metadata-off"]);
  });

  test("rejects a bad --worktree-metadata value", () => {
    expect(() => parseFlags({ worktreeMetadata: "yes" })).toThrow("'on' or 'off'");
  });
});

describe("wt init without a terminal", () => {
  test("changes nothing without flags and lists the pending decisions with their flags", async () => {
    repo = await createTestRepo({ bare: true });
    const config = await Bun.file(join(repo.root, "config")).text();

    const { exitCode, json } = await runCli(["init", "-j"], repo.root);
    expect(exitCode).toBe(0);
    expect(json).toMatchObject({ outcomes: [], cloned: false });
    const pending = (json as { pending: Array<{ actions: Array<{ flag: string }> }> }).pending;
    expect(pending.flatMap((decision) => decision.actions.map((action) => action.flag))).toEqual([
      "--fetch-refspec",
      "--main-worktree",
      "--worktree-metadata on",
    ]);
    expect(await Bun.file(join(repo.root, "config")).text()).toBe(config);
  });

  test("applies what the flags decide", async () => {
    repo = await createTestRepo({ bare: true });
    const { exitCode, json } = await runCli(
      ["init", "-j", "--yes", "--worktree-metadata", "on"],
      repo.root,
    );

    expect(exitCode).toBe(0);
    expect(json).toMatchObject({
      outcomes: [
        { id: "fetch-refspec", status: "applied" },
        { id: "worktree-metadata-on", status: "applied" },
        { id: "main-worktree", status: "applied" },
      ],
      pending: [],
    });
    expect(await git(["config", "--get", "extensions.worktreeConfig"], repo.root)).toBe("true");
    await git(["status"], join(repo.root, ".worktrees", "main"));
  });

  test("errors outside a repository instead of creating one", async () => {
    repo = await createTestRepo();
    const outside = join(repo.root, "..");
    const { exitCode, json } = await runCli(["init", "-j"], outside);

    expect(exitCode).toBe(1);
    expect(json).toMatchObject({ error: true, message: expect.stringContaining("wt init <url>") });
    expect(await gitSucceeds(["rev-parse", "--git-dir"], outside)).toBe(false);
  });

  test("exits 1 while a failing check is left undecided", async () => {
    repo = await createTestRepo({ bare: true });
    await git(["config", "extensions.worktreeConfig", "true"], repo.root);

    const { exitCode, json } = await runCli(["init", "-j"], repo.root);
    expect(exitCode).toBe(1);
    expect(json).toMatchObject({ outcomes: [], pending: expect.any(Array) });
  });

  test("honours --no- flags when cloning", async () => {
    repo = await createTestRepo();
    const parent = join(repo.root, "..");
    const { exitCode, json } = await runCli(
      ["init", "-j", "--no-main-worktree", repo.root, "clone"],
      parent,
    );

    expect(exitCode).toBe(0);
    expect(json).toMatchObject({ outcomes: [{ id: "fetch-refspec", status: "applied" }] });
    expect(await Bun.file(join(parent, "clone", ".worktrees")).exists()).toBe(false);
  });

  test("clones a URL into a bare repo set up for wt", async () => {
    repo = await createTestRepo();
    const parent = join(repo.root, "..");
    const { exitCode, json } = await runCli(["init", "-j", repo.root, "clone"], parent);

    expect(exitCode).toBe(0);
    expect(json).toMatchObject({ root: join(parent, "clone"), bare: true, cloned: true });
    expect(
      await git(["rev-parse", "--abbrev-ref", "HEAD"], join(parent, "clone", ".worktrees", "main")),
    ).toBe("main");
  });
});

describe("wt doctor", () => {
  test("changes nothing and exits 1 when a check fails", async () => {
    repo = await createTestRepo({ bare: true });
    await git(["config", "extensions.worktreeConfig", "true"], repo.root);
    const config = await Bun.file(join(repo.root, "config")).text();

    const { exitCode, json } = await runCli(["doctor", "-j"], repo.root);
    expect(exitCode).toBe(1);
    expect(json).toMatchObject({ ok: false, bare: true });
    expect(await Bun.file(join(repo.root, "config")).text()).toBe(config);
  });

  test("exits 0 when nothing fails", async () => {
    repo = await createTestRepo({ bare: true });
    const { exitCode, json } = await runCli(["doctor", "-j"], repo.root);
    expect(exitCode).toBe(0);
    expect(json).toMatchObject({ ok: true });
  });
});
