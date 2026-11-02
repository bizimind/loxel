import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { LSP_RESTART_CLOSE_CODE } from "@/api/ws-protocol";
import "@/test/temp-state-dir";

import { checkClangd, ClangdLspManager, indexDirectoryIsSymlink } from "./clangd-lsp-manager";
import { FakeClient } from "./clangd-test-client";
import { refreshCompileDatabases } from "./compile-database";
import { setCompileDatabaseChoice } from "./compile-database-store";

const TEST_TIMEOUT_MS = 60_000;
const clangdOnPath = Bun.which("clangd");
const CLANGD_IS_SUPPORTED =
  clangdOnPath !== null && (await checkClangd(clangdOnPath, process.platform)) === "ok";

const dirs: string[] = [];
let manager: ClangdLspManager | undefined;

async function makeDir(): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "clangd-database-")));
  dirs.push(dir);
  return dir;
}

async function write(root: string, relPath: string, content: string): Promise<string> {
  const file = join(root, relPath);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, content);
  return file;
}

/** A compile database defining `MARK`, which the source file needs. */
function commands(root: string, file: string, mark: number): string {
  return JSON.stringify([
    { directory: root, file, arguments: ["/usr/bin/c++", `-DMARK=${mark}`, "-c", file] },
  ]);
}

afterEach(async () => {
  await manager?.destroy();
  manager = undefined;
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe.skipIf(process.platform === "win32")("the start's arguments", () => {
  class Starting extends ClangdLspManager {
    constructor(private readonly bundled: string) {
      super(process.platform, dirs[0] ?? tmpdir(), async () => true);
    }

    protected override resolveBundledBinary(): string {
      return this.bundled;
    }

    async argsFor(wtPath: string): Promise<readonly string[]> {
      const context = { wtPath, repoTrusted: false };
      await this.resolveBinary(context);
      return this.spawnArgs(context);
    }
  }

  async function starting(): Promise<Starting> {
    const bin = await makeDir();
    const clangd = await write(bin, "clangd", '#!/bin/sh\necho "clangd version 23.1.0"\n');
    await chmod(clangd, 0o755);
    return new Starting(clangd);
  }

  const flagOf = (args: readonly string[]) =>
    args.find((arg) => arg.startsWith("--compile-commands-dir"));

  test("name the only candidate", async () => {
    const root = await makeDir();
    await write(root, "cmake-build-debug/compile_commands.json", "[]");
    const args = await (await starting()).argsFor(root);
    expect(flagOf(args)).toBe(`--compile-commands-dir=${join(root, "cmake-build-debug")}`);
  });

  test("leave the search to clangd when it finds a subproject's", async () => {
    const root = await makeDir();
    await write(root, "cmake-build-debug/compile_commands.json", "[]");
    await write(root, "sub/build/compile_commands.json", "[]");
    expect(flagOf(await (await starting()).argsFor(root))).toBeUndefined();
  });

  test("leave the search to clangd with several candidates", async () => {
    const root = await makeDir();
    await write(root, "cmake-build-debug/compile_commands.json", "[]");
    await write(root, "cmake-build-release/compile_commands.json", "[]");
    expect(flagOf(await (await starting()).argsFor(root))).toBeUndefined();
  });

  test("turn the index off when the database's index directory is a link", async () => {
    const root = await makeDir();
    await write(root, "cmake-build-debug/compile_commands.json", "[]");
    await symlink(await makeDir(), join(root, "cmake-build-debug", ".cache"));
    expect(await (await starting()).argsFor(root)).toContain("--background-index=false");
  });
});

describe.skipIf(process.platform === "win32")("indexDirectoryIsSymlink with a database", () => {
  const noGit = async () => ({ code: 1, stdout: "" });

  test("finds a link at each part of the index path beside it", async () => {
    for (const part of [".cache", ".cache/clangd", ".cache/clangd/index"]) {
      const root = await makeDir();
      const database = join(root, "cmake-build-debug");
      await mkdir(dirname(join(database, part)), { recursive: true });
      await symlink(await makeDir(), join(database, part));
      expect(await indexDirectoryIsSymlink(root, noGit)).toBe(false);
      expect(await indexDirectoryIsSymlink(root, noGit, database)).toBe(true);
    }
  });

  test("finds a link on the way to it inside the worktree", async () => {
    const root = await makeDir();
    await symlink(await makeDir(), join(root, "out"));
    expect(await indexDirectoryIsSymlink(root, noGit, join(root, "out", "x"))).toBe(true);
  });

  test("looks beside one outside the worktree, and not at the way there", async () => {
    const root = await makeDir();
    const outside = await makeDir();
    expect(await indexDirectoryIsSymlink(root, noGit, outside)).toBe(false);
    await symlink(await makeDir(), join(outside, ".cache"));
    expect(await indexDirectoryIsSymlink(root, noGit, outside)).toBe(true);
  });
});

describe.skipIf(!CLANGD_IS_SUPPORTED || process.platform === "win32")("with clangd", () => {
  const SOURCE = "int v = MARK;\nstatic_assert(MARK == 7);\n";

  async function start(root: string): Promise<{ client: FakeClient; server: ClangdLspManager }> {
    const server = new ClangdLspManager(process.platform, await makeDir());
    manager = server;
    const client = new FakeClient(server);
    await client.start(root);
    return { client, server };
  }

  test(
    "the only candidate's flags apply, and a second one restarts without them",
    async () => {
      const root = await makeDir();
      const file = await write(root, "src/a.cpp", SOURCE);
      await write(root, "cmake-build-debug/compile_commands.json", commands(root, file, 7));
      const { client, server } = await start(root);
      expect(await client.openAndWaitForDiagnostics(file)).toEqual([]);

      await write(root, "cmake-build-release/compile_commands.json", commands(root, file, 8));
      server.notifyIgnoredPathChanged(root, "cmake-build-release/compile_commands.json");
      expect((await client.closed).code).toBe(LSP_RESTART_CLOSE_CODE);

      const next = new FakeClient(server);
      await next.start(root);
      expect(await next.openAndWaitForDiagnostics(file)).not.toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "choosing a folder restarts into it",
    async () => {
      const root = await makeDir();
      const file = await write(root, "src/a.cpp", SOURCE);
      await write(root, "cmake-build-debug/compile_commands.json", commands(root, file, 8));
      await write(root, "cmake-build-release/compile_commands.json", commands(root, file, 7));
      const { client, server } = await start(root);
      expect(await client.openAndWaitForDiagnostics(file)).not.toEqual([]);

      setCompileDatabaseChoice(root, join(root, "cmake-build-release"));
      refreshCompileDatabases(root);
      expect((await client.closed).code).toBe(LSP_RESTART_CLOSE_CODE);

      const next = new FakeClient(server);
      await next.start(root);
      expect(await next.openAndWaitForDiagnostics(file)).toEqual([]);
      setCompileDatabaseChoice(root, null);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a subproject keeps its own database, with no flag from the root's build folder",
    async () => {
      const root = await makeDir();
      const file = await write(root, "sub/a.cpp", SOURCE);
      await write(root, "sub/build/compile_commands.json", commands(`${root}/sub`, file, 7));
      await write(root, "cmake-build-debug/compile_commands.json", commands(root, file, 8));
      const { client } = await start(root);
      expect(await client.openAndWaitForDiagnostics(file)).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );
});
