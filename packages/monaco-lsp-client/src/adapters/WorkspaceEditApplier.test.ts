import { beforeEach, describe, expect, mock, test } from "bun:test";

import type * as monaco from "monaco-editor";

import { fakeMonaco, fakeMonacoModule } from "../testing/fake-monaco";
import type {
  ClientCapabilities,
  FileOperationFilter,
  Range,
  RenameFilesParams,
  TextEdit,
  WorkspaceEdit,
} from "../types";
import { api, capabilities, FileOperationPatternKind } from "../types";
import type { IDisposable } from "../utils";
import type { ILspCapabilitiesRegistry } from "./LspCapabilitiesRegistry";
import type { WorkspaceFileSystem } from "./WorkspaceEditApplier";

mock.module("monaco-editor", () => fakeMonacoModule);

const { WorkspaceEditApplier, applyTextEdits } = await import("./WorkspaceEditApplier");

function fakeModel(uri: string, versionId = 1) {
  const calls: string[] = [];
  const operations: monaco.editor.IIdentifiedSingleEditOperation[][] = [];
  let version = versionId;
  const model = {
    uri: { toString: () => uri },
    isDisposed: () => false,
    getVersionId: () => version,
    pushStackElement: () => calls.push("stop"),
    pushEditOperations: (
      _selections: unknown,
      ops: monaco.editor.IIdentifiedSingleEditOperation[],
    ) => {
      calls.push("edit");
      operations.push(ops);
      version++;
      return null;
    },
  } as unknown as monaco.editor.ITextModel;
  fakeMonaco.models.push(model);
  return { model, calls, operations, type: () => version++ };
}

/** An in-memory disk keyed by uri path; `calls` records every change. */
function fakeFileSystem(files: Record<string, string>, dirs: string[] = []) {
  const disk = new Map(Object.entries(files));
  const folders = new Set(dirs);
  const calls: string[] = [];
  const refused = new Set<string>();
  const fs: WorkspaceFileSystem = {
    stat: async (uri) => {
      if (refused.has(uri.path)) throw new Error(`${uri.path} is outside the workspace`);
      if (folders.has(uri.path)) return "directory";
      return disk.has(uri.path) ? "file" : undefined;
    },
    readFile: async (uri) => {
      const content = disk.get(uri.path);
      if (content === undefined) throw new Error(`${uri.path} not found`);
      return content;
    },
    writeFile: async (uri, content) => {
      calls.push(`write ${uri.path}`);
      disk.set(uri.path, content);
    },
    createFile: async (uri) => {
      calls.push(`create ${uri.path}`);
      disk.set(uri.path, "");
    },
    rename: async (source, target) => {
      calls.push(`rename ${source.path} ${target.path}`);
      for (const [path, content] of [...disk]) {
        if (path === source.path || path.startsWith(`${source.path}/`)) {
          disk.delete(path);
          disk.set(target.path + path.slice(source.path.length), content);
        }
      }
    },
    delete: async (uri) => {
      calls.push(`delete ${uri.path}`);
      disk.delete(uri.path);
      folders.delete(uri.path);
    },
  };
  return { fs, disk, calls, refused };
}

/** A registry recording declared capabilities, and a server answering `willRenameFiles`. */
function fakeLsp(willRename: (params: RenameFilesParams) => WorkspaceEdit | null = () => null) {
  const declared: ClientCapabilities[] = [];
  const handlers = new Map<unknown, (options: unknown) => IDisposable>();
  const registry = {
    addStaticClientCapabilities: (caps: ClientCapabilities) => {
      declared.push(caps);
      return { dispose: () => {} };
    },
    registerCapabilityHandler: (capability: unknown, _static: boolean, handler: never) => {
      handlers.set(capability, handler);
      return { dispose: () => {} };
    },
  } as unknown as ILspCapabilitiesRegistry;
  const asked: RenameFilesParams[] = [];
  const server = {
    workspaceWillRenameFiles: async (params: RenameFilesParams) => {
      asked.push(params);
      return willRename(params);
    },
  } as unknown as typeof api.TServerInterface;
  const registerWillRename = (filters: FileOperationFilter[]) =>
    handlers.get(capabilities.workspaceWillRenameFiles)?.({ filters });
  return { server, registry, declared, asked, registerWillRename };
}

function applier(fs?: WorkspaceFileSystem, onFailure?: (reason: string) => void) {
  const { server, registry } = fakeLsp();
  return new WorkspaceEditApplier(server, registry, { fileSystem: fs, onFailure });
}

function range(line: number, start: number, end = start): Range {
  return { start: { line, character: start }, end: { line, character: end } };
}

function edit(line: number, start: number, end: number, newText: string): TextEdit {
  return { range: range(line, start, end), newText };
}

function docEdit(uri: string, edits: TextEdit[], version: number | null = null) {
  return { textDocument: { uri, version }, edits };
}

describe("WorkspaceEditApplier", () => {
  beforeEach(() => {
    fakeMonaco.reset();
  });

  test("declares file operations and abort failure handling only with a file system", () => {
    const withFs = fakeLsp();
    const fileSystem = fakeFileSystem({}).fs;
    new WorkspaceEditApplier(withFs.server, withFs.registry, { fileSystem }).dispose();
    const declared: unknown = withFs.declared[0]?.workspace;
    expect(declared).toEqual({
      workspaceEdit: {
        documentChanges: true,
        resourceOperations: ["create", "rename", "delete"],
        failureHandling: "abort",
      },
      fileOperations: { dynamicRegistration: true, willRename: true },
    });

    const without = fakeLsp();
    new WorkspaceEditApplier(without.server, without.registry).dispose();
    expect(without.declared[0]?.workspace).toEqual({ workspaceEdit: { documentChanges: true } });
  });

  test("edits an open model and writes a file that is not open", async () => {
    const open = fakeModel("file:///w/a.py", 4);
    const { fs, disk, calls } = fakeFileSystem({
      "/w/a.py": "def total(): ...\n",
      "/w/b.py": "from a import total\nprint(total())\n",
    });

    const result = await applier(fs).apply({
      changes: {
        "file:///w/a.py": [edit(0, 4, 9, "sum_all")],
        "file:///w/b.py": [edit(0, 14, 19, "sum_all"), edit(1, 6, 11, "sum_all")],
      },
    });

    expect(result).toEqual({ applied: true });
    expect(open.calls).toEqual(["stop", "edit", "stop"]);
    expect(open.operations[0]?.map((op) => op.text)).toEqual(["sum_all"]);
    expect(open.operations[0]?.[0]?.range).toEqual({
      startLineNumber: 1,
      startColumn: 5,
      endLineNumber: 1,
      endColumn: 10,
    });
    expect(calls).toEqual(["write /w/b.py"]);
    expect(disk.get("/w/b.py")).toBe("from a import sum_all\nprint(sum_all())\n");
    expect(disk.get("/w/a.py")).toBe("def total(): ...\n");
  });

  test("without a file system, an edit touching a file that is not open is refused whole", async () => {
    const open = fakeModel("file:///w/a.py");
    const failures: string[] = [];

    const result = await applier(undefined, (reason) => failures.push(reason)).apply({
      changes: { "file:///w/a.py": [edit(0, 0, 1, "x")], "file:///w/b.py": [edit(0, 0, 1, "y")] },
    });

    expect(result.applied).toBe(false);
    expect(result.failureReason).toContain("/w/b.py is not open");
    expect(failures).toEqual([result.failureReason ?? ""]);
    expect(open.calls).toEqual([]);
  });

  test("without a file system, file operations are unsupported", async () => {
    const edits: WorkspaceEdit = {
      documentChanges: [{ kind: "rename", oldUri: "file:///w/a.py", newUri: "file:///w/b.py" }],
    };
    expect(applier().unsupportedReason(edits)).toBe("File rename operations are not supported");
    expect(applier(fakeFileSystem({}).fs).unsupportedReason(edits)).toBeUndefined();
    expect((await applier().apply(edits)).applied).toBe(false);
  });

  test("a resource the file system refuses refuses the whole edit, open models included", async () => {
    const open = fakeModel("file:///w/a.py");
    const { fs, calls, refused } = fakeFileSystem({ "/w/a.py": "x", "/lib/os.py": "y" });
    refused.add("/lib/os.py");

    const result = await applier(fs).apply({
      changes: {
        "file:///w/a.py": [edit(0, 0, 1, "1")],
        "file:///lib/os.py": [edit(0, 0, 1, "2")],
      },
    });

    expect(result).toEqual({
      applied: false,
      failureReason: "/lib/os.py is outside the workspace",
    });
    expect(open.calls).toEqual([]);
    expect(calls).toEqual([]);
  });

  test("edits an open model the file system would refuse, as typing in it would", async () => {
    const open = fakeModel("file:///others/x.py");
    const { fs, refused } = fakeFileSystem({ "/others/x.py": "x" });
    refused.add("/others/x.py");

    const result = await applier(fs).apply({
      changes: { "file:///others/x.py": [edit(0, 0, 1, "1")] },
    });

    expect(result).toEqual({ applied: true });
    expect(open.calls).toEqual(["stop", "edit", "stop"]);
  });

  test("checks an open model edited earlier in the edit before a file operation on it", async () => {
    const open = fakeModel("file:///others/x.py");
    const { fs, calls, refused } = fakeFileSystem({ "/others/x.py": "x" });
    refused.add("/others/x.py");

    const result = await applier(fs).apply({
      documentChanges: [
        docEdit("file:///others/x.py", [edit(0, 0, 1, "1")]),
        { kind: "rename", oldUri: "file:///others/x.py", newUri: "file:///others/y.py" },
      ],
    });

    expect(result).toEqual({
      applied: false,
      failureReason: "/others/x.py is outside the workspace",
    });
    expect(open.calls).toEqual([]);
    expect(calls).toEqual([]);
  });

  test("refuses a versioned edit to a model that changed since the server computed it", async () => {
    const open = fakeModel("file:///w/a.py", 5);
    const { fs } = fakeFileSystem({ "/w/a.py": "x" });

    const result = await applier(fs).apply({
      documentChanges: [docEdit("file:///w/a.py", [edit(0, 0, 1, "1")], 4)],
    });

    expect(result.applied).toBe(false);
    expect(open.calls).toEqual([]);
  });

  test("refuses the whole edit when the model changes while unopened files are read", async () => {
    const open = fakeModel("file:///w/a.py");
    const { fs, calls } = fakeFileSystem({ "/w/a.py": "x", "/w/b.py": "y" });
    const readFile = fs.readFile.bind(fs);
    fs.readFile = async (uri) => {
      open.type();
      return readFile(uri);
    };

    const result = await applier(fs).apply({
      changes: { "file:///w/a.py": [edit(0, 0, 1, "1")], "file:///w/b.py": [edit(0, 0, 1, "2")] },
    });

    expect(result.applied).toBe(false);
    expect(result.failureReason).toContain("changed while the edit was prepared");
    expect(open.calls).toEqual([]);
    expect(calls).toEqual([]);
  });

  test("refuses the whole edit when edits to one file overlap", async () => {
    const open = fakeModel("file:///w/a.py");
    const { fs, calls } = fakeFileSystem({ "/w/a.py": "x", "/w/b.py": "abc\ndef\n" });
    const wide = { range: { start: { line: 0, character: 0 }, end: { line: 1, character: 2 } } };

    const result = await applier(fs).apply({
      changes: {
        "file:///w/a.py": [edit(0, 0, 1, "fine")],
        "file:///w/b.py": [
          { ...wide, newText: "1" },
          { range: range(0, 1, 2), newText: "2" },
        ],
      },
    });

    expect(result.applied).toBe(false);
    expect(result.failureReason).toContain("/w/b.py");
    expect(open.calls).toEqual([]);
    expect(calls).toEqual([]);
  });

  test("stops at a file that changed on disk and says how far it got", async () => {
    const { fs, disk, calls } = fakeFileSystem({ "/w/a.py": "a", "/w/b.py": "b" });
    const writeFile = fs.writeFile.bind(fs);
    fs.writeFile = async (uri, content) => {
      await writeFile(uri, content);
      disk.set("/w/b.py", "changed by someone else");
    };

    const result = await applier(fs).apply({
      documentChanges: [
        docEdit("file:///w/a.py", [edit(0, 0, 1, "A")]),
        docEdit("file:///w/b.py", [edit(0, 0, 1, "B")]),
      ],
    });

    expect(result.applied).toBe(false);
    expect(result.failedChange).toBe(1);
    expect(result.failureReason).toBe(
      "/w/b.py changed on disk while the edit was applied (1 of 2 changes were applied)",
    );
    expect(calls).toEqual(["write /w/a.py"]);
  });

  test("creates a file and writes the edits that follow into it", async () => {
    const { fs, disk, calls } = fakeFileSystem({});

    const result = await applier(fs).apply({
      documentChanges: [
        { kind: "create", uri: "file:///w/new.py" },
        docEdit("file:///w/new.py", [edit(0, 0, 0, "def moved(): ...\n")]),
      ],
    });

    expect(result).toEqual({ applied: true });
    expect(calls).toEqual(["create /w/new.py", "write /w/new.py"]);
    expect(disk.get("/w/new.py")).toBe("def moved(): ...\n");
  });

  test("create honors ignoreIfExists and overwrite, and refuses an existing file otherwise", async () => {
    const { fs, disk, calls } = fakeFileSystem({ "/w/a.py": "old" });
    const create = (options?: { overwrite?: boolean; ignoreIfExists?: boolean }) =>
      applier(fs).apply({ documentChanges: [{ kind: "create", uri: "file:///w/a.py", options }] });

    expect((await create()).failureReason).toBe("/w/a.py already exists");
    expect(await create({ ignoreIfExists: true })).toEqual({ applied: true });
    expect(calls).toEqual([]);
    expect(await create({ overwrite: true })).toEqual({ applied: true });
    expect(disk.get("/w/a.py")).toBe("");
  });

  test("renames a file and edits its importers; edits to the new path use the old content", async () => {
    const { fs, disk, calls } = fakeFileSystem({
      "/w/pkg/a.py": "x = 1\n",
      "/w/main.py": "import pkg.a\n",
    });

    const result = await applier(fs).apply({
      documentChanges: [
        { kind: "rename", oldUri: "file:///w/pkg/a.py", newUri: "file:///w/pkg/b.py" },
        docEdit("file:///w/main.py", [edit(0, 11, 12, "b")]),
        docEdit("file:///w/pkg/b.py", [edit(0, 0, 1, "y")]),
      ],
    });

    expect(result).toEqual({ applied: true });
    expect(calls).toEqual([
      "rename /w/pkg/a.py /w/pkg/b.py",
      "write /w/main.py",
      "write /w/pkg/b.py",
    ]);
    expect(disk.get("/w/main.py")).toBe("import pkg.b\n");
    expect(disk.get("/w/pkg/b.py")).toBe("y = 1\n");
    expect(disk.has("/w/pkg/a.py")).toBe(false);
  });

  test("asks a registered server for the edits a rename implies and applies them first", async () => {
    const { fs, disk, calls } = fakeFileSystem({
      "/w/src/util.ts": "export const x = 1;\n",
      "/w/src/main.ts": 'import { x } from "./util.js";\n',
    });
    const lsp = fakeLsp(() => ({
      changes: { "file:///w/src/main.ts": [edit(0, 19, 28, "./tools.js")] },
    }));
    const files = new WorkspaceEditApplier(lsp.server, lsp.registry, { fileSystem: fs });
    lsp.registerWillRename([
      { pattern: { glob: "**/*.{ts,tsx}", matches: FileOperationPatternKind.file } },
    ]);

    const result = await files.apply({
      documentChanges: [
        { kind: "rename", oldUri: "file:///w/src/util.ts", newUri: "file:///w/src/./tools.ts" },
      ],
    });

    expect(result).toEqual({ applied: true });
    expect(lsp.asked).toEqual([
      { files: [{ oldUri: "file:///w/src/util.ts", newUri: "file:///w/src/tools.ts" }] },
    ]);
    expect(calls).toEqual(["write /w/src/main.ts", "rename /w/src/util.ts /w/src/tools.ts"]);
    expect(disk.get("/w/src/main.ts")).toBe('import { x } from "./tools.js";\n');
  });

  test("does not ask a server about renames its filters do not match", async () => {
    const { fs } = fakeFileSystem({ "/w/a.py": "a" }, ["/w/pkg"]);
    const lsp = fakeLsp();
    const files = new WorkspaceEditApplier(lsp.server, lsp.registry, { fileSystem: fs });
    lsp.registerWillRename([
      { pattern: { glob: "**/*.ts" } },
      { pattern: { glob: "**", matches: FileOperationPatternKind.file } },
    ]);

    await files.apply({
      documentChanges: [{ kind: "rename", oldUri: "file:///w/pkg", newUri: "file:///w/lib" }],
    });

    expect(lsp.asked).toEqual([]);
  });

  test("rename onto an existing file: refused, skipped, or replacing it", async () => {
    const { fs, calls } = fakeFileSystem({ "/w/a.py": "a", "/w/b.py": "b" });
    const rename = (options?: { overwrite?: boolean; ignoreIfExists?: boolean }) =>
      applier(fs).apply({
        documentChanges: [
          { kind: "rename", oldUri: "file:///w/a.py", newUri: "file:///w/b.py", options },
        ],
      });

    expect((await rename()).failureReason).toBe("/w/b.py already exists");
    expect(await rename({ ignoreIfExists: true })).toEqual({ applied: true });
    expect(calls).toEqual([]);
    expect(await rename({ overwrite: true })).toEqual({ applied: true });
    expect(calls).toEqual(["delete /w/b.py", "rename /w/a.py /w/b.py"]);
  });

  test("refuses to edit an open file after renaming it in the same edit", async () => {
    const open = fakeModel("file:///w/a.py");
    const { fs, calls } = fakeFileSystem({ "/w/a.py": "a" });

    const result = await applier(fs).apply({
      documentChanges: [
        { kind: "rename", oldUri: "file:///w/a.py", newUri: "file:///w/b.py" },
        docEdit("file:///w/b.py", [edit(0, 0, 1, "b")]),
      ],
    });

    expect(result.applied).toBe(false);
    expect(open.calls).toEqual([]);
    expect(calls).toEqual([]);
  });

  test("refuses to change files inside a folder renamed earlier in the edit", async () => {
    const { fs, calls } = fakeFileSystem({ "/w/pkg/a.py": "a" }, ["/w/pkg"]);

    const result = await applier(fs).apply({
      documentChanges: [
        { kind: "rename", oldUri: "file:///w/pkg", newUri: "file:///w/lib" },
        docEdit("file:///w/lib/a.py", [edit(0, 0, 1, "b")]),
      ],
    });

    expect(result.applied).toBe(false);
    expect(result.failureReason).toContain("inside a folder renamed or deleted");
    expect(calls).toEqual([]);
  });

  test("refuses, before changing anything, a file looked at before its folder was renamed", async () => {
    const { fs, calls } = fakeFileSystem({ "/w/lib/a.py": "a" }, ["/w/lib"]);

    const result = await applier(fs).apply({
      documentChanges: [
        docEdit("file:///w/lib/a.py", [edit(0, 0, 1, "b")]),
        { kind: "rename", oldUri: "file:///w/lib", newUri: "file:///w/lib2" },
        docEdit("file:///w/lib/a.py", [edit(0, 0, 1, "c")]),
      ],
    });

    expect(result.applied).toBe(false);
    expect(result.failureReason).toContain("inside a folder renamed or deleted");
    expect(calls).toEqual([]);
  });

  test("applies edits one after another, each against the previous one's result", async () => {
    const { fs, disk } = fakeFileSystem({ "/w/a.py": "a" });
    const files = applier(fs);

    const results = await Promise.all([
      files.apply({ changes: { "file:///w/a.py": [edit(0, 0, 1, "X")] } }),
      files.apply({ changes: { "file:///w/a.py": [edit(0, 1, 1, "!")] } }),
    ]);

    expect(results).toEqual([{ applied: true }, { applied: true }]);
    expect(disk.get("/w/a.py")).toBe("X!");
  });

  test("once disposed, stops the edit being prepared and refuses the queued ones", async () => {
    const { fs, calls } = fakeFileSystem({ "/w/a.py": "a", "/w/b.py": "b" });
    const readFile = fs.readFile.bind(fs);
    const { promise: reading, resolve: readStarted } = Promise.withResolvers<void>();
    const { promise: released, resolve: release } = Promise.withResolvers<void>();
    fs.readFile = async (uri) => {
      readStarted();
      await released;
      return readFile(uri);
    };
    const failures: string[] = [];
    const files = applier(fs, (reason) => failures.push(reason));

    const first = files.apply({ changes: { "file:///w/a.py": [edit(0, 0, 1, "X")] } });
    const queued = files.apply({ changes: { "file:///w/b.py": [edit(0, 0, 1, "Y")] } });
    await reading;
    files.dispose();
    release();

    const closed = { applied: false, failureReason: "The language server connection closed" };
    expect(await first).toMatchObject(closed);
    expect(await queued).toEqual(closed);
    expect(failures).toEqual([closed.failureReason, closed.failureReason]);
    expect(calls).toEqual([]);
  });

  test("delete honors ignoreIfNotExists and needs recursive for a folder", async () => {
    const { fs, calls } = fakeFileSystem({ "/w/a.py": "a" }, ["/w/pkg"]);
    const del = (uri: string, options?: { recursive?: boolean; ignoreIfNotExists?: boolean }) =>
      applier(fs).apply({ documentChanges: [{ kind: "delete", uri, options }] });

    expect((await del("file:///w/gone.py")).failureReason).toBe("/w/gone.py does not exist");
    expect(await del("file:///w/gone.py", { ignoreIfNotExists: true })).toEqual({ applied: true });
    expect((await del("file:///w/pkg")).applied).toBe(false);
    expect(await del("file:///w/pkg", { recursive: true })).toEqual({ applied: true });
    expect(await del("file:///w/a.py")).toEqual({ applied: true });
    expect(calls).toEqual(["delete /w/pkg", "delete /w/a.py"]);
  });
});

describe("applyTextEdits", () => {
  test("applies edits across lines and keeps same-position inserts in order", () => {
    const text = "one\ntwo\nthree";
    expect(
      applyTextEdits(text, [
        edit(2, 0, 5, "3"),
        edit(0, 0, 0, "a"),
        edit(0, 0, 0, "b"),
        {
          range: { start: { line: 0, character: 3 }, end: { line: 1, character: 3 } },
          newText: "",
        },
      ]),
    ).toBe("abone\n3");
  });

  test("handles CRLF and CR line breaks", () => {
    expect(applyTextEdits("a\r\nb\rc", [edit(1, 0, 1, "B"), edit(2, 0, 1, "C")])).toBe("a\r\nB\rC");
  });

  test("clamps a character past the line end and a line past the text end", () => {
    expect(applyTextEdits("ab\r\ncd", [edit(0, 9, 9, "!"), edit(7, 0, 0, "?")])).toBe("ab!\r\ncd?");
  });

  test("applies an insert touching a replace that starts at the same place", () => {
    expect(applyTextEdits("abcdef", [edit(0, 1, 3, "X"), edit(0, 1, 1, "+")])).toBe("a+Xdef");
  });

  test("throws on overlapping edits", () => {
    expect(() => applyTextEdits("abcdef", [edit(0, 0, 3, "x"), edit(0, 2, 4, "y")])).toThrow(
      "edits overlap",
    );
  });
});
