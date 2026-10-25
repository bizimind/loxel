import { beforeEach, describe, expect, mock, test } from "bun:test";

import type * as monaco from "monaco-editor";

const WT = "/repo";

/** Real paths of the existing paths; a symlink maps to where it points. */
const disk = new Map<string, { real: string; isDir: boolean }>();
const calls: unknown[][] = [];

const actualClient = await import("@/api/client");
const { ApiError } = actualClient;
mock.module("@/api/client", () => ({
  ...actualClient,
  getPathInfo: async (path: string) => {
    const entry = disk.get(path);
    if (!entry) throw new ApiError("Path not found", 404);
    return { path: entry.real, isDir: entry.isDir };
  },
  getFileContentByPath: async (path: string) => ({
    content: path.endsWith(".latin1") ? "caf\uFFFD" : `content of ${path}`,
  }),
  writeFileContent: async (options: unknown) => {
    calls.push(["write", options]);
    return { success: true };
  },
  createProjectDir: async (wt: string, options: { dir: string; name: string }) => {
    calls.push(["createDir", wt, options]);
    const path = `${options.dir}/${options.name}`;
    disk.set(path, { real: path, isDir: true });
    return { path };
  },
  createProjectFile: async (wt: string, options: { dir: string; name: string }) => {
    calls.push(["createFile", wt, options]);
    const path = `${options.dir}/${options.name}`;
    return { path: disk.has(path) ? `${path.replace(/\.py$/, "")} 2.py` : path };
  },
}));
mock.module("@/queries/query-helpers", () => ({ invalidateDirQueries: () => {} }));
mock.module("./file-operations", () => ({
  renameFile: async (options: { path: string; newName: string }) => {
    calls.push(["rename", options]);
    return `${options.path.slice(0, options.path.lastIndexOf("/"))}/${options.newName}`;
  },
  moveFile: async (options: { srcPath: string; destDir: string; newName?: string }) => {
    calls.push(["move", options]);
    return `${options.destDir}/${options.newName ?? options.srcPath.split("/").pop()}`;
  },
  deleteFile: async (options: unknown) => {
    calls.push(["delete", options]);
  },
}));

const { createLspWorkspaceFiles } = await import("./lsp-workspace-files");

function uri(value: string): monaco.Uri {
  const match = /^([^:]+):\/\/([^/]*)([^?#]*)/.exec(value);
  if (!match) throw new Error(`Not a uri: ${value}`);
  const [, scheme, authority, path] = match;
  return {
    scheme,
    authority,
    path,
    query: "",
    fragment: value.includes("#") ? value.slice(value.indexOf("#") + 1) : "",
    toString: () => value,
  } as unknown as monaco.Uri;
}

function exists(path: string, isDir = false, real = path): void {
  disk.set(path, { real, isDir });
}

beforeEach(() => {
  disk.clear();
  calls.length = 0;
  exists(WT, true, `/private${WT}`);
  exists(`${WT}/pkg`, true, `/private${WT}/pkg`);
  exists(`${WT}/pkg/a.py`, false, `/private${WT}/pkg/a.py`);
});

describe("createLspWorkspaceFiles", () => {
  const files = () => createLspWorkspaceFiles(WT);

  test("stat reports files, folders and missing paths of the worktree", async () => {
    expect(await files().stat(uri("file:///repo/pkg/a.py"))).toBe("file");
    expect(await files().stat(uri("loxel://HEAD/repo/pkg"))).toBe("directory");
    expect(await files().stat(uri("file:///repo/pkg/new.py"))).toBeUndefined();
  });

  test("refuses paths outside the worktree, in dependencies or git, and other schemes", async () => {
    for (const refused of [
      "file:///usr/lib/python3.12/os.py",
      "file:///repo-other/a.py",
      "file:///repo",
      "file:///repo/../etc/hosts",
      "file:///repo/.venv/lib/python3.12/site-packages/requests/api.py",
      "file:///repo/node_modules/left-pad/index.js",
      "file:///repo/.git/config",
      "file:///repo/.venv/lib/python3.12/os.py",
      "file:///repo/.pixi/envs/default/lib/python3.12/os.py",
      "file:///repo/.worktrees/feature/src/a.ts",
      "loxel://compare/repo/pkg/a.py#panel-old",
      "loxel://HEAD/repo/pkg/a.py#new",
    ]) {
      await expect(files().stat(uri(refused))).rejects.toThrow();
    }
  });

  test("refuses a path whose real path leaves the worktree", async () => {
    exists(`${WT}/vendored`, true, "/opt/vendored");
    exists(`${WT}/vendored/lib.py`, false, "/opt/vendored/lib.py");

    await expect(files().stat(uri("file:///repo/vendored/lib.py"))).rejects.toThrow(
      "outside the worktree",
    );
    await expect(files().stat(uri("file:///repo/vendored/new/x.py"))).rejects.toThrow(
      "outside the worktree",
    );
  });

  test("writes without formatting, with a fresh nonce", async () => {
    await files().writeFile(uri("file:///repo/pkg/a.py"), "x = 1\n");
    const [[kind, options]] = calls as [[string, Record<string, unknown>]];
    expect(kind).toBe("write");
    expect(options).toMatchObject({ path: "/repo/pkg/a.py", content: "x = 1\n", worktreePath: WT });
    expect(options.format).toBeUndefined();
    expect(typeof options.nonce).toBe("string");
  });

  test("creates missing parent folders before the file", async () => {
    await files().createFile(uri("file:///repo/pkg/sub/deeper/new.py"));
    expect(calls).toEqual([
      ["createDir", WT, { dir: "/repo/pkg", name: "sub" }],
      ["createDir", WT, { dir: "/repo/pkg/sub", name: "deeper" }],
      ["createFile", WT, { dir: "/repo/pkg/sub/deeper", name: "new.py" }],
    ]);
  });

  test("renames within a folder, and moves then renames across folders", async () => {
    await files().rename(uri("file:///repo/pkg/a.py"), uri("file:///repo/pkg/b.py"));
    expect(calls).toEqual([
      ["rename", { wt: WT, path: "/repo/pkg/a.py", newName: "b.py", isDetached: false }],
    ]);

    calls.length = 0;
    await files().rename(uri("file:///repo/pkg/a.py"), uri("file:///repo/lib/c.py"));
    expect(calls).toEqual([
      ["createDir", WT, { dir: "/repo", name: "lib" }],
      ["move", { wt: WT, srcPath: "/repo/pkg/a.py", destDir: "/repo/lib", newName: "c.py" }],
    ]);
  });

  test("refuses to read a file that is not UTF-8, which writing back would corrupt", async () => {
    await expect(files().readFile(uri("file:///repo/pkg/notes.latin1"))).rejects.toThrow(
      "not UTF-8",
    );
  });

  test("removes the file the create route made under a free name when the path appeared", async () => {
    await expect(files().createFile(uri("file:///repo/pkg/a.py"))).rejects.toThrow(
      "/repo/pkg/a.py already exists",
    );
    expect(calls.at(-1)).toEqual([
      "delete",
      { wt: WT, path: "/repo/pkg/a 2.py", isDetached: false },
    ]);
  });
});
