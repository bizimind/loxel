import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rename, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  type FileEvent,
  existingFileChangeType,
  FileChangeType,
  splitWatchedFilesRegistration,
  WatchedFilesForwarder,
  withWatchedFilesCapability,
} from "./lsp-watched-files";

const ROOT = "/work/tree";
const caseInsensitive = process.platform === "darwin" || process.platform === "win32";

function forwarder(
  watchers: unknown[],
  send: (changes: FileEvent[]) => void = () => {},
  root = ROOT,
): WatchedFilesForwarder {
  const f = new WatchedFilesForwarder(root, send, 20);
  f.register("reg", { watchers });
  return f;
}

describe("withWatchedFilesCapability", () => {
  test("adds the capability to initialize and keeps the client's other workspace capabilities", () => {
    const out = JSON.parse(
      withWatchedFilesCapability(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { capabilities: { workspace: { applyEdit: true } } },
        }),
      ),
    );
    expect(out.params.capabilities.workspace).toEqual({
      applyEdit: true,
      didChangeWatchedFiles: { dynamicRegistration: true },
    });
  });

  test("leaves every other frame untouched", () => {
    const didOpen = JSON.stringify({
      jsonrpc: "2.0",
      method: "textDocument/didOpen",
      params: { textDocument: { text: '"initialize"' } },
    });
    expect(withWatchedFilesCapability(didOpen)).toBe(didOpen);
    // A document whose text spells out an initialize request.
    const didChange = JSON.stringify({
      jsonrpc: "2.0",
      method: "textDocument/didChange",
      params: { contentChanges: [{ text: '{"method": "initialize", "params": {}}' }] },
    });
    expect(withWatchedFilesCapability(didChange)).toBe(didChange);
    expect(withWatchedFilesCapability("not json")).toBe("not json");
  });
});

describe("splitWatchedFilesRegistration", () => {
  const watched = { id: "w1", method: "workspace/didChangeWatchedFiles", registerOptions: {} };
  const config = { id: "c1", method: "workspace/didChangeConfiguration" };

  test("takes the watched-files entries out of a registration and keeps the rest", () => {
    const split = splitWatchedFilesRegistration(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 4,
        method: "client/registerCapability",
        params: { registrations: [watched, config] },
      }),
    );
    expect(split?.requestId).toBe(4);
    expect(split?.register).toBe(true);
    expect(split?.entries).toEqual([watched]);
    expect(JSON.parse(split!.remainder!)).toEqual({
      jsonrpc: "2.0",
      id: 4,
      method: "client/registerCapability",
      params: { registrations: [config] },
    });
  });

  test("an unregistration of only watched files leaves nothing to forward", () => {
    const split = splitWatchedFilesRegistration(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "u",
        method: "client/unregisterCapability",
        params: { unregisterations: [{ id: "w1", method: "workspace/didChangeWatchedFiles" }] },
      }),
    );
    expect(split).toMatchObject({ requestId: "u", register: false, remainder: null });
    expect(split?.entries.map((e) => e.id)).toEqual(["w1"]);
  });

  test("ignores other frames", () => {
    const frames = [
      { id: 1, method: "client/registerCapability", params: { registrations: [config] } },
      // A notification that merely mentions the method.
      { method: "window/logMessage", params: { message: "workspace/didChangeWatchedFiles" } },
      { method: "client/registerCapability", params: { registrations: [watched] } },
      { id: 2, result: { registrations: [watched] } },
    ];
    for (const frame of frames) {
      expect(
        splitWatchedFilesRegistration(JSON.stringify({ jsonrpc: "2.0", ...frame })),
      ).toBeNull();
    }
  });
});

describe("WatchedFilesForwarder glob matching", () => {
  test("basedpyright's watchers: `**` and `**/pyrightconfig.json` relative to the worktree", () => {
    const all = forwarder([{ globPattern: "**", kind: 7 }]);
    expect(all.kindsFor(`${ROOT}/main.py`)).toBe(7);
    expect(all.kindsFor(`${ROOT}/pkg/.hidden/mod.py`)).toBe(7);
    expect(all.kindsFor("/elsewhere/main.py")).toBe(0);
    expect(all.kindsFor("/work/tree-other/main.py")).toBe(0);

    const config = forwarder([{ globPattern: "**/pyrightconfig.json" }]);
    expect(config.kindsFor(`${ROOT}/pyrightconfig.json`)).toBe(7);
    expect(config.kindsFor(`${ROOT}/sub/pyrightconfig.json`)).toBe(7);
    expect(config.kindsFor(`${ROOT}/pyproject.toml`)).toBe(0);
  });

  test("TypeScript's absolute globs, lowercased on case-insensitive file systems", () => {
    const f = forwarder([{ globPattern: "/work/Tree/**/*", kind: 7 }]);
    expect(f.kindsFor("/work/Tree/src/a.ts")).toBe(7);
    expect(f.kindsFor("/work/tree/src/a.ts")).toBe(caseInsensitive ? 7 : 0);
    expect(f.kindsFor("/work/Treehouse/a.ts")).toBe(0);

    const lowered = forwarder([{ globPattern: "/work/tree/**/*.{ts,tsx}" }]);
    expect(lowered.kindsFor("/work/Tree/src/a.tsx")).toBe(caseInsensitive ? 7 : 0);
    expect(lowered.kindsFor("/work/tree/src/a.json")).toBe(0);
  });

  test("an absolute glob spelling out the worktree path reads that path literally", () => {
    const root = "/work/repo [old]/{wt}";
    const f = forwarder([{ globPattern: `${root}/**/*` }], () => {}, root);
    expect(f.kindsFor(`${root}/src/a.ts`)).toBe(7);
    expect(f.kindsFor("/work/repo o/w/src/a.ts")).toBe(0);
  });

  test("relative patterns match under their base URI or workspace folder only", () => {
    const f = forwarder([
      { globPattern: { baseUri: `file://${ROOT}/lib`, pattern: "**/*.py" } },
      { globPattern: { baseUri: { uri: `file://${ROOT}/conf`, name: "conf" }, pattern: "*.toml" } },
      { globPattern: { baseUri: "untitled:x", pattern: "**" } },
    ]);
    expect(f.kindsFor(`${ROOT}/lib/a/b.py`)).toBe(7);
    expect(f.kindsFor(`${ROOT}/b.py`)).toBe(0);
    expect(f.kindsFor(`${ROOT}/conf/x.toml`)).toBe(7);
    expect(f.kindsFor(`${ROOT}/conf/sub/x.toml`)).toBe(0);
  });

  test("kinds combine across watchers and registrations, and unregistering drops them", () => {
    const f = forwarder([{ globPattern: "**/*.py", kind: 1 }]);
    f.register("other", { watchers: [{ globPattern: "**", kind: 4 }] });
    expect(f.kindsFor(`${ROOT}/a.py`)).toBe(5);
    expect(f.unregister("other")).toBe(true);
    expect(f.unregister("other")).toBe(false);
    expect(f.kindsFor(`${ROOT}/a.py`)).toBe(1);
  });

  test("malformed watchers are ignored", () => {
    const f = forwarder([null, { kind: 7 }, { globPattern: 42 }, { globPattern: "**/*.py" }]);
    expect(f.kindsFor(`${ROOT}/a.py`)).toBe(7);
    f.register("bad", "nonsense");
    expect(f.kindsFor(`${ROOT}/a.txt`)).toBe(0);
  });
});

describe("existingFileChangeType", () => {
  const at = (birthtimeMs: number, mtimeMs: number, ctimeMs = mtimeMs) => ({
    birthtimeMs,
    mtimeMs,
    ctimeMs,
  });

  test("with birth times: written right after creation, or moved into place, is created", () => {
    expect(existingFileChangeType(at(10_000, 10_200), true)).toBe(FileChangeType.Created);
    expect(existingFileChangeType(at(10_000, 60_000), false)).toBe(FileChangeType.Changed);
    expect(existingFileChangeType(at(10_000, 20_000, 60_000), true)).toBe(FileChangeType.Created);
  });

  test("without birth times: created when first seen, changed after", () => {
    expect(existingFileChangeType(at(0, 60_000), false)).toBe(FileChangeType.Created);
    expect(existingFileChangeType(at(0, 60_000), true)).toBe(FileChangeType.Changed);
    expect(existingFileChangeType(at(0, 20_000, 60_000), true)).toBe(FileChangeType.Created);
  });
});

describe("WatchedFilesForwarder batching", () => {
  let dir: string | undefined;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  async function tempTree(): Promise<string> {
    dir = await realpath(await mkdtemp(join(tmpdir(), "lsp-watched-files-")));
    return dir;
  }

  test("reports created, changed and deleted files in one debounced batch", async () => {
    const root = await tempTree();
    await mkdir(join(root, "pkg"));
    await writeFile(join(root, "pkg", "new.py"), "x = 1\n");
    await writeFile(join(root, "old.py"), "y = 1\n");
    // Last written long after it was born: a change, not a creation.
    const later = new Date(Date.now() + 60_000);
    await utimes(join(root, "old.py"), later, later);
    const stats = await Bun.file(join(root, "old.py")).stat();
    const canTellCreation = stats.birthtimeMs !== 0 && stats.mtimeMs - stats.birthtimeMs >= 1000;

    const batches: FileEvent[][] = [];
    const f = forwarder([{ globPattern: "**/*.py" }], (changes) => batches.push(changes), root);
    f.queue([join(root, "pkg", "new.py")]);
    f.queue([join(root, "old.py"), join(root, "gone.py"), join(root, "notes.txt")]);
    await Bun.sleep(150);

    expect(batches).toHaveLength(1);
    const uri = (p: string) => pathToFileURL(join(root, p)).href;
    expect(batches[0]).toEqual([
      { uri: uri("pkg/new.py"), type: FileChangeType.Created },
      // Only platforms that record birth times can tell a change from a creation.
      {
        uri: uri("old.py"),
        type: canTellCreation ? FileChangeType.Changed : FileChangeType.Created,
      },
      { uri: uri("gone.py"), type: FileChangeType.Deleted },
    ]);
  });

  test("reports a file moved into place as created", async () => {
    const root = await tempTree();
    const outside = join(root, "..", `${root.split("/").pop()}-outside.py`);
    await writeFile(outside, "x = 1\n");
    await Bun.sleep(1100);
    await writeFile(outside, "x = 2\n");
    await Bun.sleep(1100);
    const moved = join(root, "helpers.py");
    await rename(outside, moved);

    const batches: FileEvent[][] = [];
    const f = forwarder([{ globPattern: "**" }], (changes) => batches.push(changes), root);
    f.queue([moved]);
    await Bun.sleep(100);
    expect(batches).toEqual([[{ uri: pathToFileURL(moved).href, type: FileChangeType.Created }]]);
  }, 10_000);

  test("a continuously written file does not hold a batch back past the maximum wait", async () => {
    const root = await tempTree();
    const batches: FileEvent[][] = [];
    const f = new WatchedFilesForwarder(root, (changes) => batches.push(changes), 50, 200);
    f.register("reg", { watchers: [{ globPattern: "**" }] });
    const started = Date.now();
    while (batches.length === 0 && Date.now() - started < 1000) {
      f.queue([join(root, "app.log")]);
      await Bun.sleep(20);
    }
    expect(batches).toHaveLength(1);
    expect(Date.now() - started).toBeLessThan(600);
  });

  test("replays changes queued before the server registered its watchers", async () => {
    const root = await tempTree();
    await writeFile(join(root, "early.py"), "x = 1\n");
    const batches: FileEvent[][] = [];
    const f = new WatchedFilesForwarder(root, (changes) => batches.push(changes), 20);
    f.queue([join(root, "early.py"), join(root, "early.txt")]);
    await Bun.sleep(60);
    expect(batches).toHaveLength(0);

    f.register("reg", { watchers: [{ globPattern: "**/*.py" }] });
    await Bun.sleep(100);
    expect(batches).toEqual([
      [{ uri: pathToFileURL(join(root, "early.py")).href, type: FileChangeType.Created }],
    ]);
  });

  test("keeps early changes for a later registration that wants them", async () => {
    const root = await tempTree();
    await writeFile(join(root, "a.ts"), "export {};\n");
    await writeFile(join(root, "tsconfig.json"), "{}\n");
    const batches: FileEvent[][] = [];
    const f = new WatchedFilesForwarder(root, (changes) => batches.push(changes), 20);
    f.queue([join(root, "a.ts"), join(root, "tsconfig.json")]);

    // An empty registration does not end the early phase.
    f.register("empty", { watchers: [] });
    f.queue([join(root, "late.ts")]);
    // Two entries of one request: each takes only what its watchers want.
    f.register("sources", { watchers: [{ globPattern: "**/*.ts" }] });
    f.register("config", { watchers: [{ globPattern: "**/tsconfig.json" }] });
    await Bun.sleep(100);

    const uris = batches.flat().map((e) => e.uri);
    expect(uris.toSorted()).toEqual(
      ["a.ts", "late.ts", "tsconfig.json"].map((p) => pathToFileURL(join(root, p)).href).toSorted(),
    );
  });

  test("reports every file of a batch larger than the stat concurrency, in queue order", async () => {
    const root = await tempTree();
    const names = Array.from({ length: 150 }, (_, i) => `m${i}.py`);
    const { promise, resolve } = Promise.withResolvers<FileEvent[]>();
    const f = forwarder([{ globPattern: "**/*.py" }], resolve, root);
    f.queue(names.map((n) => join(root, n)));
    const changes = await promise;
    expect(changes.map((e) => e.uri)).toEqual(names.map((n) => pathToFileURL(join(root, n)).href));
  });

  test("drops changes a watcher's kind excludes", async () => {
    const root = await tempTree();
    const batches: FileEvent[][] = [];
    const f = forwarder([{ globPattern: "**", kind: 1 }], (changes) => batches.push(changes), root);
    f.queue([join(root, "deleted.py")]);
    await Bun.sleep(100);
    expect(batches).toHaveLength(0);
  });

  test("sends nothing after dispose", async () => {
    const root = await tempTree();
    const batches: FileEvent[][] = [];
    const f = forwarder([{ globPattern: "**" }], (changes) => batches.push(changes), root);
    f.queue([join(root, "a.py")]);
    f.dispose();
    await Bun.sleep(100);
    expect(batches).toHaveLength(0);
  });
});
