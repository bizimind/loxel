import { afterEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";

import { git, gitSucceeds, transformToBare } from "../git/index.ts";
import { createTestRepo, writeHook, type TestRepo } from "../test-repo.ts";
import { executeAdd } from "./add.ts";
import { executeInit } from "./init.ts";
import {
  ensureWorktreeId,
  getWorktreeMeta,
  isWorktreeMetadataEnabled,
  METADATA_OFF_MESSAGE,
  parseMetaAssignments,
  setWorktreeMeta,
  unsetWorktreeMeta,
} from "./meta.ts";
import { executeMove } from "./move.ts";
import { executeRemove } from "./remove.ts";
import { findWorktreeById, listManagedWorktrees } from "./worktrees.ts";

let repo: TestRepo;

afterEach(() => repo.cleanup());

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

async function enableMetadata(root: string): Promise<void> {
  const result = await executeInit(root, { apply: ["worktree-metadata-on"] });
  expect(result.outcomes.map((outcome) => outcome.status)).toEqual(["applied"]);
}

async function metaOf(name: string) {
  return (await getWorktreeMeta({ name, repoPath: repo.root })).meta;
}

for (const bare of [true, false]) {
  describe(`${bare ? "bare" : "regular"} layout`, () => {
    describe("with metadata off", () => {
      test("reads are empty and writes point to wt init", async () => {
        repo = await createTestRepo({ bare });
        await executeAdd({ name: "a", repoPath: repo.root });

        expect(await isWorktreeMetadataEnabled(repo.root)).toBe(false);
        expect(await metaOf("a")).toEqual({});
        expect((await listManagedWorktrees(repo.root))[0]?.meta).toEqual({});

        const params = { name: "a", repoPath: repo.root };
        await expect(setWorktreeMeta({ ...params, values: { x: "1" } })).rejects.toThrow(
          METADATA_OFF_MESSAGE,
        );
        await expect(unsetWorktreeMeta({ ...params, keys: ["x"] })).rejects.toThrow(
          METADATA_OFF_MESSAGE,
        );
        await expect(ensureWorktreeId(params)).rejects.toThrow(METADATA_OFF_MESSAGE);
        // Nothing leaks into the shared config, which every worktree reads.
        expect(await gitSucceeds(["config", "--get-regexp", "^wt-meta\\."], repo.root)).toBe(false);
      });

      test("wt add without metadata still works; with it, fails before creating anything", async () => {
        repo = await createTestRepo({ bare });
        expect((await executeAdd({ name: "a", repoPath: repo.root })).meta).toEqual({});

        await expect(
          executeAdd({ name: "b", repoPath: repo.root, meta: { x: "1" } }),
        ).rejects.toThrow(METADATA_OFF_MESSAGE);
        expect((await listManagedWorktrees(repo.root)).map((wt) => wt.name)).toEqual(["a"]);
      });
    });

    describe("with metadata on", () => {
      test("wt add assigns a wt-id and stores the given keys lowercase", async () => {
        repo = await createTestRepo({ bare });
        await enableMetadata(repo.root);

        const added = await executeAdd({
          name: "a",
          repoPath: repo.root,
          meta: { "Loxel-Parent-WT": "abc", note: "" },
        });
        expect(added.meta).toEqual({
          "wt-id": expect.stringMatching(UUID),
          "loxel-parent-wt": "abc",
          note: "",
        });
        expect(await metaOf("a")).toEqual(added.meta);
        expect((await listManagedWorktrees(repo.root))[0]?.meta).toEqual(added.meta);

        const other = await executeAdd({ name: "b", repoPath: repo.root });
        expect(other.meta["wt-id"]).not.toBe(added.meta["wt-id"]);
      });

      test("the init hook can read the new worktree's metadata", async () => {
        repo = await createTestRepo({ bare });
        await enableMetadata(repo.root);
        await writeHook(
          repo.root,
          "init.wt.sh",
          'git config --worktree --get wt-meta.wt-id > "$WT_ROOT/id.txt"',
        );

        const added = await executeAdd({ name: "a", repoPath: repo.root });
        expect(added.hookRan).toBe(true);
        expect((await Bun.file(join(repo.root, "id.txt")).text()).trim()).toBe(
          added.meta["wt-id"] ?? "missing",
        );
      });

      test("an older worktree gets a wt-id when its metadata is first written, not when read", async () => {
        repo = await createTestRepo({ bare });
        await executeAdd({ name: "old", repoPath: repo.root });
        await enableMetadata(repo.root);

        expect(await metaOf("old")).toEqual({});
        const set = await setWorktreeMeta({ name: "old", repoPath: repo.root, values: { k: "v" } });
        expect(set.meta).toEqual({ "wt-id": expect.stringMatching(UUID), k: "v" });

        // The id stays put across later writes.
        const unset = await unsetWorktreeMeta({ name: "old", repoPath: repo.root, keys: ["k"] });
        const id = set.meta["wt-id"] ?? "missing";
        expect(unset.meta).toEqual({ "wt-id": id });
        expect(await ensureWorktreeId({ name: "old", repoPath: repo.root })).toBe(id);
      });

      test("ensureWorktreeId assigns an id once", async () => {
        repo = await createTestRepo({ bare });
        await executeAdd({ name: "old", repoPath: repo.root });
        await enableMetadata(repo.root);

        const id = await ensureWorktreeId({ name: "old", repoPath: repo.root });
        expect(id).toMatch(UUID);
        expect(await ensureWorktreeId({ name: "old", repoPath: repo.root })).toBe(id);
      });

      test("wt-* keys are reserved and invalid keys are rejected", async () => {
        repo = await createTestRepo({ bare });
        await enableMetadata(repo.root);
        await executeAdd({ name: "a", repoPath: repo.root });
        const params = { name: "a", repoPath: repo.root };

        await expect(setWorktreeMeta({ ...params, values: { "WT-ID": "x" } })).rejects.toThrow(
          "reserved",
        );
        await expect(unsetWorktreeMeta({ ...params, keys: ["wt-id"] })).rejects.toThrow("reserved");
        await expect(
          executeAdd({ name: "b", repoPath: repo.root, meta: { "wt-x": "1" } }),
        ).rejects.toThrow("reserved");
        for (const key of ["", "1abc", "a_b", "a.b", "-a"]) {
          await expect(setWorktreeMeta({ ...params, values: { [key]: "x" } })).rejects.toThrow(
            "Invalid metadata key",
          );
        }
      });

      test("values round-trip verbatim", async () => {
        repo = await createTestRepo({ bare });
        await enableMetadata(repo.root);
        await executeAdd({ name: "a", repoPath: repo.root });

        const values = {
          dash: "--not-an-option",
          multi: "line 1\nline 2",
          eq: "a=b",
          quote: '"x" \\',
        };
        const result = await setWorktreeMeta({ name: "a", repoPath: repo.root, values });
        expect(result.meta).toMatchObject(values);
      });

      test("metadata survives a rename and a detached HEAD, and ids still resolve", async () => {
        repo = await createTestRepo({ bare });
        await enableMetadata(repo.root);
        const added = await executeAdd({ name: "a", repoPath: repo.root, meta: { k: "v" } });
        const id = added.meta["wt-id"] ?? "missing";

        const moved = await executeMove({ oldName: "a", name: "feat/b", repoPath: repo.root });
        await git(["checkout", "--detach"], moved.path);

        expect(await metaOf("feat/b")).toEqual(added.meta);
        expect(await findWorktreeById(id, repo.root)).toMatchObject({
          name: "feat/b",
          path: moved.path,
          branch: null,
          meta: added.meta,
        });
        expect(await findWorktreeById("no-such-id", repo.root)).toBeNull();
      });

      test("metadata goes with a removed worktree", async () => {
        repo = await createTestRepo({ bare });
        await enableMetadata(repo.root);
        const first = await executeAdd({ name: "a", repoPath: repo.root, meta: { k: "v" } });
        await executeRemove({ name: "a", repoPath: repo.root, deleteBranch: true, force: false });

        expect(await findWorktreeById(first.meta["wt-id"] ?? "missing", repo.root)).toBeNull();
        const again = await executeAdd({ name: "a", repoPath: repo.root });
        expect(again.meta).toEqual({ "wt-id": expect.stringMatching(UUID) });
        expect(again.meta["wt-id"]).not.toBe(first.meta["wt-id"]);
      });

      test("parallel writes to different worktrees don't conflict", async () => {
        repo = await createTestRepo({ bare });
        await enableMetadata(repo.root);
        const names = ["a", "b", "c", "d", "e"];
        for (const name of names) await executeAdd({ name, repoPath: repo.root });

        await Promise.all(
          names.map((name) =>
            setWorktreeMeta({ name, repoPath: repo.root, values: { owner: name, extra: "x" } }),
          ),
        );

        const managed = await listManagedWorktrees(repo.root);
        expect(managed.map((wt) => [wt.name, wt.meta.owner, wt.meta.extra])).toEqual(
          names.map((name) => [name, name, "x"]),
        );
        // Each worktree reads only its own values.
        for (const wt of managed) {
          expect(await git(["config", "--get", "wt-meta.owner"], wt.path)).toBe(wt.name);
        }
      });

      test("concurrent writes to one worktree all land and agree on one wt-id", async () => {
        repo = await createTestRepo({ bare });
        await executeAdd({ name: "old", repoPath: repo.root });
        await enableMetadata(repo.root);
        const params = { name: "old", repoPath: repo.root };

        const keys = ["k1", "k2", "k3", "k4", "k5", "k6"];
        const [ids] = await Promise.all([
          Promise.all(keys.map(() => ensureWorktreeId(params))),
          Promise.all(keys.map((key) => setWorktreeMeta({ ...params, values: { [key]: key } }))),
        ]);

        const meta = await metaOf("old");
        const id = meta["wt-id"] ?? "missing";
        expect(new Set(ids)).toEqual(new Set([id]));
        expect(meta).toMatchObject(Object.fromEntries(keys.map((key) => [key, key])));
        const worktreePath = join(repo.root, ".worktrees", "old");
        expect(await git(["config", "--get-all", "wt-meta.wt-id"], worktreePath)).toBe(id);
      });

      test("wt add run inside a worktree inherits none of its metadata", async () => {
        repo = await createTestRepo({ bare });
        await enableMetadata(repo.root);
        const parent = await executeAdd({ name: "parent", repoPath: repo.root, meta: { k: "v" } });

        const child = await executeAdd({ name: "child", repoPath: parent.path });
        expect(child.meta).toEqual({ "wt-id": expect.stringMatching(UUID) });
        expect(child.meta["wt-id"]).not.toBe(parent.meta["wt-id"]);
        expect(await git(["config", "--get-all", "wt-meta.k"], child.path).catch(() => "")).toBe(
          "",
        );
      });

      test("a copy git made with plain worktree add is ignored, then replaced on write", async () => {
        repo = await createTestRepo({ bare });
        await enableMetadata(repo.root);
        const parent = await executeAdd({ name: "parent", repoPath: repo.root, meta: { k: "v" } });
        const copyPath = join(repo.root, ".worktrees", "copy");
        await git(["worktree", "add", "-b", "copy", copyPath], parent.path);
        // git copied the parent's config file, metadata included.
        expect(await git(["config", "--get", "wt-meta.k"], copyPath)).toBe("v");

        expect(await metaOf("copy")).toEqual({});
        expect(await findWorktreeById(parent.meta["wt-id"] ?? "missing", repo.root)).toMatchObject({
          name: "parent",
        });

        const set = await setWorktreeMeta({
          name: "copy",
          repoPath: repo.root,
          values: { x: "1" },
        });
        expect(set.meta).toEqual({ "wt-id": expect.stringMatching(UUID), x: "1" });
        expect(set.meta["wt-id"]).not.toBe(parent.meta["wt-id"]);
        expect(await metaOf("parent")).toEqual(parent.meta);
      });

      test("concurrent first writes to a copied section agree on one wt-id and all land", async () => {
        repo = await createTestRepo({ bare });
        await enableMetadata(repo.root);
        const parent = await executeAdd({ name: "parent", repoPath: repo.root, meta: { k: "v" } });
        await git(
          ["worktree", "add", "-b", "copy", join(repo.root, ".worktrees", "copy")],
          parent.path,
        );
        const params = { name: "copy", repoPath: repo.root };

        const keys = ["k1", "k2", "k3", "k4", "k5", "k6"];
        const [ids] = await Promise.all([
          Promise.all(keys.map(() => ensureWorktreeId(params))),
          Promise.all(keys.map((key) => setWorktreeMeta({ ...params, values: { [key]: key } }))),
        ]);

        const meta = await metaOf("copy");
        expect(new Set(ids)).toEqual(new Set([meta["wt-id"] ?? "missing"]));
        expect(meta["wt-id"]).not.toBe(parent.meta["wt-id"]);
        expect(meta).toEqual({
          "wt-id": expect.stringMatching(UUID),
          ...Object.fromEntries(keys.map((key) => [key, key])),
        });
      });

      test("one unreadable config file does not hide the others' metadata", async () => {
        repo = await createTestRepo({ bare });
        await enableMetadata(repo.root);
        const good = await executeAdd({ name: "good", repoPath: repo.root, meta: { k: "v" } });
        const bad = await executeAdd({ name: "bad", repoPath: repo.root });
        const badFile = join(
          await git(["rev-parse", "--absolute-git-dir"], bad.path),
          "config.worktree",
        );
        await Bun.write(badFile, `${await Bun.file(badFile).text()}[broken\n`);

        const managed = await listManagedWorktrees(repo.root);
        expect(managed.map((wt) => [wt.name, wt.meta])).toEqual([
          ["bad", {}],
          ["good", good.meta],
        ]);
      });

      test("a worktree whose checkout is gone still lists its metadata", async () => {
        repo = await createTestRepo({ bare });
        await enableMetadata(repo.root);
        const added = await executeAdd({ name: "a", repoPath: repo.root, meta: { k: "v" } });
        await rm(added.path, { recursive: true, force: true });

        expect((await listManagedWorktrees(repo.root))[0]?.meta).toEqual(added.meta);
      });

      test("finds the config file of a worktree added with relative paths", async () => {
        repo = await createTestRepo({ bare });
        await enableMetadata(repo.root);
        const path = join(repo.root, ".worktrees", "rel");
        await git(
          ["-c", "worktree.useRelativePaths=true", "worktree", "add", "-b", "rel", path],
          repo.root,
        );

        const set = await setWorktreeMeta({ name: "rel", repoPath: repo.root, values: { k: "v" } });
        expect(set.meta.k).toBe("v");
        expect(await git(["config", "--get", "wt-meta.k"], path)).toBe("v");
      });
    });
  });
}

test("the main worktree of a regular repo has metadata of its own", async () => {
  repo = await createTestRepo();
  await enableMetadata(repo.root);
  const linked = await executeAdd({ name: "a", repoPath: repo.root });
  const main = repo.root.split("/").at(-1) ?? "";

  const set = await setWorktreeMeta({ name: main, repoPath: repo.root, values: { k: "main" } });
  expect((await metaOf(main)).k).toBe("main");
  expect(await findWorktreeById(set.meta["wt-id"] ?? "missing", repo.root)).toMatchObject({
    path: repo.root,
  });
  expect(linked.meta.k).toBeUndefined();
  expect((await metaOf("a")).k).toBeUndefined();
});

test("converting a regular repo to bare keeps the main worktree's metadata and id", async () => {
  repo = await createTestRepo();
  await enableMetadata(repo.root);
  const main = repo.root.split("/").at(-1) ?? "";
  const before = await setWorktreeMeta({ name: main, repoPath: repo.root, values: { k: "v" } });

  const worktreePath = await transformToBare(repo.root, "main");

  expect(await metaOf("main")).toEqual(before.meta);
  expect(await findWorktreeById(before.meta["wt-id"] ?? "missing", repo.root)).toMatchObject({
    path: worktreePath,
  });
  const after = await setWorktreeMeta({ name: "main", repoPath: repo.root, values: { x: "1" } });
  expect(after.meta).toEqual({ ...before.meta, x: "1" });
});

describe("parseMetaAssignments", () => {
  test("splits at the first '=' and normalizes keys", () => {
    expect(parseMetaAssignments(["A=1", "b=x=y", "c=", "a=2"])).toEqual({
      a: "2",
      b: "x=y",
      c: "",
    });
  });

  test("rejects a pair without '=', an invalid key and a reserved one", () => {
    expect(() => parseMetaAssignments(["novalue"])).toThrow("Expected key=value");
    expect(() => parseMetaAssignments(["a.b=1"])).toThrow("Invalid metadata key");
    expect(() => parseMetaAssignments(["wt-id=1"])).toThrow("reserved");
  });
});
