import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { findRustProject, isReadableRustManifest } from "./rust-project-lookup";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeDir(): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "rust-lookup-")));
  roots.push(dir);
  return dir;
}

async function write(root: string, file: string, text = ""): Promise<string> {
  const full = join(root, file);
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, text);
  return full;
}

const PACKAGE = "[package]\nname = 'x'\n";

describe("findRustProject", () => {
  test("takes the nearest manifest, however deep", async () => {
    const wt = await makeDir();
    await write(wt, "Cargo.toml", PACKAGE);
    const manifest = await write(wt, "services/alpha/rust/Cargo.toml", PACKAGE);
    const file = await write(wt, "services/alpha/rust/src/deep/mod.rs");
    expect(findRustProject(file, wt)).toEqual({ kind: "manifest", manifest });
  });

  test("calls a file with no manifest up to the root loose", async () => {
    const wt = await makeDir();
    const file = await write(wt, "scratch/x.rs");
    expect(findRustProject(file, wt)).toEqual({ kind: "loose", file });
  });

  test("looks no further up than the worktree", async () => {
    const outer = await makeDir();
    await write(outer, "Cargo.toml", PACKAGE);
    const file = await write(outer, "wt/x.rs");
    expect(findRustProject(file, join(outer, "wt"))).toEqual({ kind: "loose", file });
  });

  test("adds nothing for a file outside the worktree", async () => {
    const wt = await makeDir();
    const other = await makeDir();
    await write(other, "Cargo.toml", PACKAGE);
    expect(findRustProject(await write(other, "src/lib.rs"), wt)).toBeNull();
    expect(findRustProject("/rustlib/src/rust/library/std/src/lib.rs", wt)).toBeNull();
  });

  test("adds nothing for dependencies, build output and nested worktrees", async () => {
    const wt = await makeDir();
    for (const dir of ["node_modules/pkg", ".worktrees/other", "a/.git/x", "a/.venv/lib"]) {
      await write(wt, `${dir}/Cargo.toml`, PACKAGE);
      expect(findRustProject(await write(wt, `${dir}/src/lib.rs`), wt)).toBeNull();
    }
    await write(wt, "a/target/CACHEDIR.TAG");
    await write(wt, "a/target/package/dep/Cargo.toml", PACKAGE);
    expect(findRustProject(await write(wt, "a/target/package/dep/src/lib.rs"), wt)).toBeNull();
    await write(wt, "nested/.git", "gitdir: /repo/.git/worktrees/nested\n");
    await write(wt, "nested/Cargo.toml", PACKAGE);
    expect(findRustProject(await write(wt, "nested/src/lib.rs"), wt)).toBeNull();
  });

  test("takes a submodule's crate, also in a linked worktree", async () => {
    const wt = await makeDir();
    for (const [dir, gitdir] of [
      ["sub", "../.git/modules/sub"],
      ["linked", "../../main/.git/worktrees/wt/modules/linked"],
      ["placed", "/home/me/worktrees/repo/.git/modules/placed"],
    ] as const) {
      await write(wt, `${dir}/.git`, `gitdir: ${gitdir}\n`);
      const manifest = await write(wt, `${dir}/Cargo.toml`, PACKAGE);
      expect(findRustProject(await write(wt, `${dir}/src/lib.rs`), wt)).toEqual({
        kind: "manifest",
        manifest,
      });
    }
  });

  test("takes a crate that is merely named target", async () => {
    const wt = await makeDir();
    const manifest = await write(wt, "crates/target/Cargo.toml", PACKAGE);
    expect(findRustProject(await write(wt, "crates/target/src/lib.rs"), wt)).toEqual({
      kind: "manifest",
      manifest,
    });
  });

  test("adds nothing for a vendored crate", async () => {
    const wt = await makeDir();
    await write(wt, "vendor/dep/Cargo.toml", PACKAGE);
    await write(wt, "vendor/dep/.cargo-checksum.json", "{}");
    expect(findRustProject(await write(wt, "vendor/dep/src/lib.rs"), wt)).toBeNull();
  });

  test("does not follow links out of the worktree", async () => {
    const wt = await makeDir();
    const other = await makeDir();
    const outsideManifest = await write(other, "Cargo.toml", PACKAGE);
    await write(other, "src/lib.rs");
    await symlink(other, join(wt, "linked"));
    expect(findRustProject(join(wt, "linked/src/lib.rs"), wt)).toBeNull();

    await mkdir(join(wt, "crate/src"), { recursive: true });
    await symlink(outsideManifest, join(wt, "crate/Cargo.toml"));
    const file = await write(wt, "crate/src/lib.rs");
    expect(findRustProject(file, wt)).toEqual({ kind: "loose", file });
    expect(isReadableRustManifest(join(wt, "crate/Cargo.toml"), wt)).toBe(false);
  });

  test("follows a link that stays in the worktree", async () => {
    const wt = await makeDir();
    await write(wt, "shared/Cargo.toml", PACKAGE);
    await mkdir(join(wt, "crate"));
    await symlink(join(wt, "shared/Cargo.toml"), join(wt, "crate/Cargo.toml"));
    const file = await write(wt, "crate/lib.rs");
    expect(findRustProject(file, wt)).toEqual({
      kind: "manifest",
      manifest: join(wt, "crate/Cargo.toml"),
    });
  });

  test("skips a manifest that is no regular file of at most 1 MiB", async () => {
    const wt = await makeDir();
    await mkdir(join(wt, "dir/Cargo.toml"), { recursive: true });
    const inDir = await write(wt, "dir/x.rs");
    expect(findRustProject(inDir, wt)).toEqual({ kind: "loose", file: inDir });
    await write(wt, "big/Cargo.toml", "#".repeat(1024 * 1024 + 1));
    const inBig = await write(wt, "big/x.rs");
    expect(findRustProject(inBig, wt)).toEqual({ kind: "loose", file: inBig });
  });

  describe("workspaces", () => {
    test("loads a listed member through its workspace, by name or pattern", async () => {
      const wt = await makeDir();
      const manifest = await write(
        wt,
        "svc/Cargo.toml",
        "[workspace]\nmembers = ['crates/*', './tool/']\n",
      );
      for (const member of ["crates/one", "tool"]) {
        await write(wt, `svc/${member}/Cargo.toml`, PACKAGE);
        expect(findRustProject(await write(wt, `svc/${member}/src/lib.rs`), wt)).toEqual({
          kind: "manifest",
          manifest,
        });
      }
    });

    test("follows a package naming its workspace, if it stays in the worktree", async () => {
      const wt = await makeDir();
      const manifest = await write(wt, "root/Cargo.toml", "[workspace]\nmembers = ['away/m']\n");
      await write(wt, "root/away/m/Cargo.toml", "[package]\nname = 'm'\nworkspace = '../..'\n");
      expect(findRustProject(await write(wt, "root/away/m/lib.rs"), wt)).toEqual({
        kind: "manifest",
        manifest,
      });

      const own = await write(wt, "gone/Cargo.toml", "[package]\nworkspace = '../../../..'\n");
      expect(findRustProject(await write(wt, "gone/lib.rs"), wt)).toEqual({
        kind: "manifest",
        manifest: own,
      });
    });

    test("keeps a package's own manifest when the workspace it names does not list it", async () => {
      const wt = await makeDir();
      await write(wt, "root/Cargo.toml", "[workspace]\nmembers = []\n");
      await write(wt, "plain/Cargo.toml", PACKAGE);
      for (const named of ["../root", "../plain"]) {
        const own = await write(wt, "m/Cargo.toml", `[package]\nworkspace = '${named}'\n`);
        expect(findRustProject(await write(wt, "m/lib.rs"), wt)).toEqual({
          kind: "manifest",
          manifest: own,
        });
      }
    });

    test("lets an explicit member beat an exclude, and a pattern match one level", async () => {
      const wt = await makeDir();
      const root = await write(
        wt,
        "Cargo.toml",
        "[workspace]\nmembers = ['crates/*', 'skip/kept']\nexclude = ['skip']\n",
      );
      await write(wt, "skip/kept/Cargo.toml", PACKAGE);
      expect(findRustProject(await write(wt, "skip/kept/lib.rs"), wt)).toEqual({
        kind: "manifest",
        manifest: root,
      });
      const deep = await write(wt, "crates/a/b/Cargo.toml", PACKAGE);
      expect(findRustProject(await write(wt, "crates/a/b/lib.rs"), wt)).toEqual({
        kind: "manifest",
        manifest: deep,
      });
    });

    test("keeps a crate's own manifest when it is excluded or not listed", async () => {
      const wt = await makeDir();
      await write(
        wt,
        "Cargo.toml",
        "[workspace]\nmembers = ['crates/*']\nexclude = ['crates/x']\n",
      );
      for (const dir of ["crates/x", "fuzz"]) {
        const manifest = await write(wt, `${dir}/Cargo.toml`, PACKAGE);
        expect(findRustProject(await write(wt, `${dir}/src/lib.rs`), wt)).toEqual({
          kind: "manifest",
          manifest,
        });
      }
    });

    test("keeps a crate that is a workspace of its own", async () => {
      const wt = await makeDir();
      await write(wt, "Cargo.toml", "[workspace]\nmembers = ['own']\n");
      const manifest = await write(wt, "own/Cargo.toml", `${PACKAGE}[workspace]\n`);
      expect(findRustProject(await write(wt, "own/lib.rs"), wt)).toEqual({
        kind: "manifest",
        manifest,
      });
    });

    test("leaves a broken manifest to cargo's error", async () => {
      const wt = await makeDir();
      await write(wt, "Cargo.toml", "[workspace]\nmembers = ['bad']\n");
      const manifest = await write(wt, "bad/Cargo.toml", "[package\n");
      expect(findRustProject(await write(wt, "bad/lib.rs"), wt)).toEqual({
        kind: "manifest",
        manifest,
      });
    });
  });
});
