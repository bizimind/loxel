import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";

import { until } from "@/test/until";

let toasts: string[] = [];
mock.module("@/components/ui/toast", () => ({
  showToast: (message: string) => toasts.push(message),
}));

let opened: string[] = [];
mock.module("@/lib/open-path", () => ({
  openFile: async (_server: string, { filePath }: { filePath: string }) => {
    opened.push(filePath);
  },
}));

// The files on disk, the writes that reached them, and how the server answers writes.
let disk: Record<string, string> = {};
let writes: Array<{ path: string; content: string; format?: boolean }> = [];
let serverDown = false;
let refuseWrites = false;
/** Paths the server answers with a plain 404, as for a worktree it has no resources for. */
let unserved = new Set<string>();
/** Runs once, right after the next read: another program writing before the retry's commit. */
let afterNextRead: (() => void) | null = null;
/** Runs as each write reaches the server. */
let onWrite: (() => void) | null = null;
/** The projects the server lists. */
let projects: Array<import("@/api/project-model").EnrichedProject> = [];
const actualClient = await import("@/api/client");
mock.module("@/api/client", () => ({
  ...actualClient,
  getProjects: async () => ({ projects, homeDir: "/home", homeDraftsDir: "/home/drafts" }),
  getFileContentByPath: async (path: string) => {
    if (serverDown) throw new TypeError("Failed to fetch");
    if (unserved.has(path)) throw new actualClient.ApiError("Not in any worktree", 404);
    const content = disk[path];
    if (content === undefined) throw new actualClient.ApiError("File not found", 404, "ENOENT");
    const after = afterNextRead;
    afterNextRead = null;
    after?.();
    return { content };
  },
  writeFileContent: async (options: {
    path: string;
    content: string;
    format?: boolean;
    expectedContent?: string;
  }) => {
    if (serverDown) throw new TypeError("Failed to fetch");
    if (refuseWrites) throw new actualClient.ApiError("Permission denied", 500);
    onWrite?.();
    if (options.expectedContent !== undefined && disk[options.path] !== options.expectedContent) {
      throw new actualClient.ApiError("changed on disk", 409, "EDISKCHANGED");
    }
    writes.push({ path: options.path, content: options.content, format: options.format });
    disk[options.path] = options.content;
    return { success: true, content: options.content };
  },
}));

const { onWorktreeSavesDrained, saveEditorContent } = await import("./save-editor-content");
const {
  adoptOutboxEntry,
  findAdoptableEntry,
  forgetOutboxPath,
  initSaveOutbox,
  isRetriableSaveError,
  outboxEditorClosing,
  outboxEntriesForTests,
  resetSaveOutboxForTests,
  retryQueuedSaves,
  unsavedFilesOf,
} = await import("./save-outbox");
const { dispatchLoxelEvent } = await import("./loxel-events");
type OutboxEntry = import("./save-outbox").OutboxEntry;
type OutboxStorage = import("./save-outbox").OutboxStorage;
type StoredOutboxEntry = import("./save-outbox").StoredOutboxEntry;
const { toServerId, worktreeRef } = await import("@/api/worktree-ref");
/** Another server, holding the same paths. */
const THERE = toServerId("other-server");
const { fileEditorKey, useEditorStateStore, viewEditorKey } = await import("@/store/editor-state");
const localServerModule = await import("@/api/local-server");
const { localRef, localServerId } = localServerModule;
const { useProjectStore } = await import("@/store/projects");

const TEST_SERVER = localServerId();
const REPO = localRef("/repo");
const FILE = "/repo/a.ts";
const KEY = fileEditorKey(TEST_SERVER, FILE);

/** Open an editor of FILE that loaded `content` and now shows `editorText`. */
function openEditor(content: string, editorText: { current: string }): void {
  const store = useEditorStateStore.getState();
  store.openFile(KEY, TEST_SERVER, FILE);
  store.setBaseContent(KEY, content);
  store.registerEditorCallbacks(
    KEY,
    () => editorText.current,
    (merged) => {
      editorText.current = merged;
      return merged;
    },
  );
  store.registerPendingEdit(KEY, () => ({ content: editorText.current }));
}

function editor() {
  return useEditorStateStore.getState().files.get(KEY);
}

/** Storage that keeps copies of the entries, as IndexedDB does, across "reloads" of the outbox. */
function memoryStorage(): { storage: OutboxStorage; stored: Map<string, StoredOutboxEntry> } {
  const stored = new Map<string, StoredOutboxEntry>();
  return {
    stored,
    storage: {
      load: async () => [...stored.values()].map((entry) => structuredClone(entry)),
      put: async (entry) => void stored.set(entry.id, structuredClone(entry)),
      remove: async (id) => void stored.delete(id),
    },
  };
}

/** The window reloads: its editors are gone, and a new outbox loads what was stored. */
async function reload(storage: OutboxStorage): Promise<void> {
  resetSaveOutboxForTests();
  useEditorStateStore.setState({ files: new Map() });
  await initSaveOutbox({ storage });
}

/** An entry a window that is gone left in storage. */
function leftBehind(overrides: Partial<OutboxEntry> = {}): OutboxEntry {
  return {
    id: "e1",
    instanceId: "gone-editor",
    ownerId: "gone-window",
    editorKey: KEY,
    server: TEST_SERVER,
    filePath: FILE,
    worktreePath: "/repo",
    base: "a\nb\nc\n",
    content: "a\nb\nc\nd\n",
    seq: 1,
    status: "sending",
    disk: null,
    ...overrides,
  };
}

beforeEach(() => {
  toasts = [];
  opened = [];
  disk = { [FILE]: "a\nb\nc\n" };
  writes = [];
  serverDown = false;
  refuseWrites = false;
  unserved = new Set();
  afterNextRead = null;
  onWrite = null;
  projects = [];
});

afterEach(() => {
  resetSaveOutboxForTests();
  useEditorStateStore.setState({ files: new Map() });
});

describe("isRetriableSaveError", () => {
  test("retries what can pass and not real refusals", () => {
    expect(isRetriableSaveError(new TypeError("Failed to fetch"))).toBe(true);
    expect(isRetriableSaveError(new actualClient.ApiError("not in any worktree", 404))).toBe(true);
    expect(isRetriableSaveError(new actualClient.ApiError("unavailable", 503))).toBe(true);
    // The server no longer accepts the window's session: kept for after the reload.
    expect(isRetriableSaveError(new actualClient.ApiError("session", 401))).toBe(true);
    expect(isRetriableSaveError(new actualClient.ApiError("gone", 404, "ENOENT"))).toBe(false);
    expect(isRetriableSaveError(new actualClient.ApiError("folder", 400))).toBe(false);
    expect(isRetriableSaveError(new actualClient.ApiError("EACCES", 500))).toBe(false);
  });
});

describe("open editor", () => {
  test("a save the server cannot take is queued and retried once it is back", async () => {
    const text = { current: "a\nb\nc\nd\n" };
    openEditor("a\nb\nc\n", text);
    serverDown = true;

    expect(await saveEditorContent(FILE, text.current, REPO, undefined, KEY)).toBe(false);
    expect(editor()?.state).toBe("dirty");
    expect(editor()?.queued).toBe(true);

    serverDown = false;
    await retryQueuedSaves();
    expect(disk[FILE]).toBe("a\nb\nc\nd\n");
    expect(editor()?.queued).toBe(false);
    expect(outboxEntriesForTests()).toEqual([]);
  });

  test("a refused save is kept for review, not queued, and its editor says why", async () => {
    const text = { current: "a\nb\nc\nd\n" };
    openEditor("a\nb\nc\n", text);
    refuseWrites = true;

    expect(await saveEditorContent(FILE, text.current, REPO, undefined, KEY)).toBe(false);
    expect(editor()?.queued).toBe(false);
    expect(editor()?.saveRefused).toBe("Permission denied");
    expect(outboxEntriesForTests()).toEqual([
      expect.objectContaining({
        status: "review",
        content: text.current,
        refusal: "Permission denied",
      }),
    ]);
    // Shown by the open editor's banner: nothing is reopened or toasted.
    expect(opened).toEqual([]);
    expect(toasts).toEqual([]);
  });

  test("a refused save survives its editor unmounting and is shown when it mounts again", async () => {
    const text = { current: "a\nb\nc\nd\n" };
    openEditor("a\nb\nc\n", text);
    refuseWrites = true;
    await saveEditorContent(FILE, text.current, REPO, undefined, KEY);

    // A worktree switch unmounts the editor.
    const closing = editor();
    if (!closing) throw new Error("no editor");
    outboxEditorClosing(KEY, closing, REPO);
    useEditorStateStore.getState().closeFile(KEY);

    // Switching back mounts it again: it shows the refused edits, unsaved, with the reason.
    const entry = findAdoptableEntry(TEST_SERVER, FILE);
    expect(entry?.content).toBe("a\nb\nc\nd\n");
    useEditorStateStore.getState().openFile(KEY, TEST_SERVER, FILE);
    adoptOutboxEntry(KEY, entry!);
    expect(editor()?.state).toBe("dirty");
    expect(editor()?.saveRefused).toBe("Permission denied");

    // The banner stays while a new save is in flight, and goes once one is written.
    refuseWrites = false;
    const saved = saveEditorContent(FILE, "a\nb\nc\nd\n", REPO, undefined, KEY);
    expect(editor()?.saveRefused).toBe("Permission denied");
    expect(await saved).toBe(true);
    expect(editor()?.saveRefused).toBeNull();
    expect(outboxEntriesForTests()).toEqual([]);
  });

  test("a refused save is kept across a reload", async () => {
    const { storage } = memoryStorage();
    await initSaveOutbox({ storage });
    openEditor("a\nb\nc\n", { current: "a\nb\nc\nd\n" });
    refuseWrites = true;
    await saveEditorContent(FILE, "a\nb\nc\nd\n", REPO, undefined, KEY);

    await reload(storage);
    expect(outboxEntriesForTests()).toEqual([
      expect.objectContaining({ status: "review", refusal: "Permission denied" }),
    ]);
    expect(opened).toEqual([FILE]);

    // The tab it opens takes it over with its reason.
    openEditor("a\nb\nc\n", { current: "a\nb\nc\nd\n" });
    adoptOutboxEntry(KEY, findAdoptableEntry(TEST_SERVER, FILE)!);
    expect(editor()?.state).toBe("dirty");
    expect(editor()?.saveRefused).toBe("Permission denied");
  });

  test("a save in flight after a refusal is recovered queued, without the refusal", async () => {
    const { storage, stored } = memoryStorage();
    stored.set("e1", leftBehind({ status: "sending", refusal: "Permission denied" }));
    serverDown = true; // the retry the recovery starts waits
    await reload(storage);
    expect(outboxEntriesForTests()).toEqual([expect.objectContaining({ status: "queued" })]);
    expect(outboxEntriesForTests()[0]?.refusal).toBeUndefined();
  });

  test("a refused save taken over by a reopened tab merges what changed on disk meanwhile", async () => {
    const text = { current: "a\nb\nc\nd\n" };
    openEditor("a\nb\nc\n", text);
    refuseWrites = true;
    await saveEditorContent(FILE, text.current, REPO, undefined, KEY);
    const closing = editor();
    if (!closing) throw new Error("no editor");
    outboxEditorClosing(KEY, closing, REPO);
    useEditorStateStore.getState().closeFile(KEY);

    disk[FILE] = "A\nb\nc\n"; // another program edits the file while no tab is open
    const reopened = { current: "a\nb\nc\nd\n" };
    openEditor("A\nb\nc\n", reopened);
    adoptOutboxEntry(KEY, findAdoptableEntry(TEST_SERVER, FILE)!);
    await until(() => reopened.current === "A\nb\nc\nd\n");
    expect(editor()?.state).toBe("dirty");
  });

  test("a compare side's refused save is shown in the file's tab once the side closes", async () => {
    const side = viewEditorKey("compare-1:new");
    const store = useEditorStateStore.getState();
    store.openFile(side, TEST_SERVER, FILE);
    store.setBaseContent(side, "a\nb\nc\n");
    refuseWrites = true;
    await saveEditorContent(FILE, "a\nX\nc\n", REPO, undefined, side);
    const closing = useEditorStateStore.getState().files.get(side);
    if (!closing) throw new Error("no side");
    outboxEditorClosing(side, closing, REPO);
    useEditorStateStore.getState().closeFile(side);

    await until(() => opened.length > 0);
    expect(opened).toEqual([FILE]);
    expect(findAdoptableEntry(TEST_SERVER, FILE)?.content).toBe("a\nX\nc\n");
  });

  test("later saves wait behind a queued one, and the retry sends the newest", async () => {
    const text = { current: "a\nb\nc\nd\n" };
    openEditor("a\nb\nc\n", text);
    serverDown = true;
    await saveEditorContent(FILE, text.current, REPO, undefined, KEY);

    serverDown = false;
    disk[FILE] = "A\nb\nc\n"; // another program edits the file meanwhile
    text.current = "a\nb\nc\nd\ne\n";
    // Not written blindly over the other program's edit: it waits for the retry's merge.
    void saveEditorContent(FILE, text.current, REPO, undefined, KEY);
    expect(writes).toEqual([]);

    await retryQueuedSaves();
    expect(disk[FILE]).toBe("A\nb\nc\nd\ne\n");
    expect(text.current).toBe("A\nb\nc\nd\ne\n");
  });

  test("a retry that conflicts with the disk leaves the editor diverged, not overwritten", async () => {
    const text = { current: "a\nX\nc\n" };
    openEditor("a\nb\nc\n", text);
    serverDown = true;
    await saveEditorContent(FILE, text.current, REPO, undefined, KEY);

    serverDown = false;
    disk[FILE] = "a\nY\nc\n";
    await retryQueuedSaves();
    expect(disk[FILE]).toBe("a\nY\nc\n");
    expect(editor()?.state).toBe("diverged");
    expect(outboxEntriesForTests().map((e) => e.status)).toEqual(["review"]);

    // Accepting the disk version gives up the edits.
    useEditorStateStore.getState().acceptDiskVersion(KEY);
    expect(outboxEntriesForTests()).toEqual([]);
  });

  test("a retry sends what the editor shows now, not the older queued content", async () => {
    const text = { current: "a\nb\nc\nd\n" };
    openEditor("a\nb\nc\n", text);
    serverDown = true;
    await saveEditorContent(FILE, text.current, REPO, undefined, KEY);
    text.current = "a\nb\nc\nd\nTYPED\n"; // typed since, its autosave not due yet

    serverDown = false;
    await retryQueuedSaves();
    expect(disk[FILE]).toBe("a\nb\nc\nd\nTYPED\n");
  });

  test("a retried autosave keeps its own format options", async () => {
    const text = { current: "a\nb\nc\nd\n" };
    openEditor("a\nb\nc\n", text);
    // The pending edit carries the explicit-save options, as `takePendingEdit` does.
    useEditorStateStore
      .getState()
      .registerPendingEdit(KEY, () => ({ content: text.current, options: { format: true } }));
    serverDown = true;
    await saveEditorContent(FILE, text.current, REPO, undefined, KEY); // an autosave: no format options

    serverDown = false;
    await retryQueuedSaves();
    expect(writes.at(-1)?.format).toBeUndefined();
  });

  test("a second external change does not undo edits kept through the first", async () => {
    const text = { current: "USER\nb\nc\nd\ne\n" };
    openEditor("a\nb\nc\nd\ne\n", text);
    const store = useEditorStateStore.getState();
    store.markDirty(KEY);
    store.handleDiskChange(KEY, [], "a\nb\nc\nd\nB\n");
    expect(text.current).toBe("USER\nb\nc\nd\nB\n");
    store.handleDiskChange(KEY, [], "a\nb\nC\nd\nB\n");
    expect(text.current).toBe("USER\nb\nC\nd\nB\n");
  });

  test("a save confirmed without its echo is the base of the next one", async () => {
    const text = { current: "a\nb1\nc\n" };
    openEditor("a\nb\nc\n", text);
    await saveEditorContent(FILE, text.current, REPO, undefined, KEY); // written; its echo never comes
    useEditorStateStore.getState().handleSaveError(KEY, [...editor()!.pendingNonces][0]!);

    text.current = "a\nb12\nc\n";
    serverDown = true;
    await saveEditorContent(FILE, text.current, REPO, undefined, KEY);
    serverDown = false;
    await retryQueuedSaves();

    // Same line as the first save: merged against the first save's content, not a conflict.
    expect(disk[FILE]).toBe("a\nb12\nc\n");
    expect(editor()?.state).not.toBe("diverged");
  });
});

describe("closed editor", () => {
  async function queueAndClose(base: string, content: string): Promise<void> {
    const text = { current: content };
    openEditor(base, text);
    serverDown = true;
    await saveEditorContent(FILE, content, REPO, undefined, KEY);
    useEditorStateStore.getState().closeFile(KEY);
    serverDown = false;
  }

  test("its queued save is written when the disk still holds the base", async () => {
    await queueAndClose("a\nb\nc\n", "a\nb\nc\nd\n");
    await retryQueuedSaves();
    expect(disk[FILE]).toBe("a\nb\nc\nd\n");
    expect(outboxEntriesForTests()).toEqual([]);
  });

  test("its queued save is merged onto a changed disk", async () => {
    await queueAndClose("a\nb\nc\n", "a\nb\nc\nd\n");
    disk[FILE] = "A\nb\nc\n";
    await retryQueuedSaves();
    expect(disk[FILE]).toBe("A\nb\nc\nd\n");
  });

  test("a save the server refuses is kept for review", async () => {
    await queueAndClose("a\nb\nc\n", "a\nb\nc\nd\n");
    refuseWrites = true;
    await retryQueuedSaves();
    expect(outboxEntriesForTests().map((e) => e.status)).toEqual(["review"]);
    expect(opened).toEqual([FILE]);
  });

  test("a conflict is shown at once in the file's tab when it is open and clean", async () => {
    const side = viewEditorKey("compare-1:new");
    const store = useEditorStateStore.getState();
    store.openFile(side, TEST_SERVER, FILE);
    store.setBaseContent(side, "a\nb\nc\n");
    serverDown = true;
    await saveEditorContent(FILE, "a\nX\nc\n", REPO, undefined, side);
    store.closeFile(side);
    serverDown = false;

    const tabText = { current: "a\nY\nc\n" };
    openEditor("a\nY\nc\n", tabText);
    disk[FILE] = "a\nY\nc\n";
    await retryQueuedSaves();
    expect(tabText.current).toBe("a\nX\nc\n");
    expect(editor()?.state).toBe("diverged");
    expect(editor()?.diskContent).toBe("a\nY\nc\n");
    expect(opened).toEqual([]);
  });

  test("a conflict reopens the file, whose tab shows the edits against the disk version", async () => {
    await queueAndClose("a\nb\nc\n", "a\nX\nc\n");
    disk[FILE] = "a\nY\nc\n";
    await retryQueuedSaves();
    expect(disk[FILE]).toBe("a\nY\nc\n");
    expect(opened).toEqual([FILE]);
    expect(toasts).toHaveLength(1);

    const entry = findAdoptableEntry(TEST_SERVER, FILE);
    expect(entry?.content).toBe("a\nX\nc\n");
    useEditorStateStore.getState().openFile(KEY, TEST_SERVER, FILE);
    adoptOutboxEntry(KEY, entry!);
    expect(editor()?.state).toBe("diverged");
    expect(editor()?.diskContent).toBe("a\nY\nc\n");
    expect(findAdoptableEntry(TEST_SERVER, FILE)).toBeNull();
  });

  test("only a tab of the save's server takes it over or deletes it", async () => {
    await queueAndClose("a\nb\nc\n", "a\nb\nc\nd\n");

    expect(findAdoptableEntry(THERE, FILE)).toBeNull();
    forgetOutboxPath(THERE, FILE);
    expect(findAdoptableEntry(TEST_SERVER, FILE)?.content).toBe("a\nb\nc\nd\n");
    forgetOutboxPath(TEST_SERVER, FILE);
    expect(findAdoptableEntry(TEST_SERVER, FILE)).toBeNull();
  });

  test("a reopened tab takes over a save still waiting, as unsaved edits", async () => {
    await queueAndClose("a\nb\nc\n", "a\nb\nc\nd\n");
    const entry = findAdoptableEntry(TEST_SERVER, FILE);
    useEditorStateStore.getState().openFile(KEY, TEST_SERVER, FILE);
    adoptOutboxEntry(KEY, entry!);
    expect(editor()?.state).toBe("dirty");
    expect(editor()?.baseContent).toBe("a\nb\nc\n");
    expect(editor()?.queued).toBe(true);
  });
});

describe("recovery", () => {
  test("saves left by a window that is gone are written at start", async () => {
    const { storage, stored } = memoryStorage();
    stored.set("e1", leftBehind());
    await initSaveOutbox({ storage });
    await retryQueuedSaves();
    expect(disk[FILE]).toBe("a\nb\nc\nd\n");
    expect(stored.size).toBe(0);
    expect(toasts).toEqual(["Saved edits from the last session to a.ts"]);
  });

  test("a save from an earlier session is shown, not merged, when the disk changed", async () => {
    const { storage, stored } = memoryStorage();
    stored.set("e1", leftBehind());
    disk[FILE] = "A\nb\nc\n"; // a clean merge, but onto a version the edits were not made on

    await initSaveOutbox({ storage });
    await retryQueuedSaves();
    expect(disk[FILE]).toBe("A\nb\nc\n");
    expect(opened).toEqual([FILE]);
    expect(outboxEntriesForTests().map((e) => [e.status, e.disk])).toEqual([
      ["review", "A\nb\nc\n"],
    ]);
  });

  test("a save in review is shown at start", async () => {
    const { storage, stored } = memoryStorage();
    stored.set("e1", leftBehind({ status: "review", disk: "A\nb\nc\n" }));
    await initSaveOutbox({ storage });
    expect(opened).toEqual([FILE]);
    expect(outboxEntriesForTests().map((e) => e.status)).toEqual(["review"]);
  });

  test("only the window's server's saves are taken; another server's stay stored, untouched", async () => {
    const { storage, stored } = memoryStorage();
    const elsewhere = leftBehind({ id: "e2", server: THERE });
    stored.set("e1", leftBehind());
    stored.set("e2", elsewhere);

    await initSaveOutbox({ storage });
    await retryQueuedSaves();

    expect(writes.map((write) => write.path)).toEqual([FILE]);
    expect(outboxEntriesForTests()).toEqual([]);
    expect(stored.get("e2")).toEqual(elsewhere);
  });

  test("a save stored before saves named their server is kept for review, never written", async () => {
    const { storage, stored } = memoryStorage();
    const { server: _, ...legacy } = leftBehind({ status: "queued" });
    stored.set("e1", legacy);

    await initSaveOutbox({ storage });
    await retryQueuedSaves();

    expect(writes).toEqual([]);
    expect(outboxEntriesForTests().map((e) => [e.status, e.server])).toEqual([
      ["review", TEST_SERVER],
    ]);
    expect(stored.get("e1")?.server).toBe(TEST_SERVER);
    expect(opened).toEqual([FILE]);
  });

  test("the entries of a window still open are left to it", async () => {
    const { storage, stored } = memoryStorage();
    stored.set("e1", leftBehind({ ownerId: "open-window" }));
    stored.set(
      "e2",
      leftBehind({
        id: "e2",
        filePath: "/repo/b.ts",
        editorKey: fileEditorKey(TEST_SERVER, "/repo/b.ts"),
      }),
    );
    disk["/repo/b.ts"] = "a\nb\nc\n";
    // Each window holds a lock named after itself while it is open.
    const locks = {
      query: async () => ({ held: [{ name: "loxel-save-outbox:open-window" }], pending: [] }),
      request: async (_name: string, fn: () => Promise<unknown>) => fn(),
    };
    Object.defineProperty(navigator, "locks", { value: locks, configurable: true });
    try {
      await initSaveOutbox({ storage });
    } finally {
      Reflect.deleteProperty(navigator, "locks");
    }

    expect(outboxEntriesForTests().map((e) => e.id)).toEqual(["e2"]);
    expect(stored.get("e1")?.ownerId).toBe("open-window");
    await retryQueuedSaves();
    expect(disk["/repo/b.ts"]).toBe("a\nb\nc\nd\n");
    expect(disk[FILE]).toBe("a\nb\nc\n");
  });

  test("a conflict of an open editor is shown again after a reload", async () => {
    const { storage } = memoryStorage();
    await initSaveOutbox({ storage });
    const text = { current: "a\nX\nc\n" };
    openEditor("a\nb\nc\n", text);
    serverDown = true;
    await saveEditorContent(FILE, text.current, REPO, undefined, KEY);
    serverDown = false;
    disk[FILE] = "a\nY\nc\n";
    await retryQueuedSaves();
    expect(editor()?.state).toBe("diverged");

    await reload(storage);
    expect(opened).toEqual([FILE]);
    const entry = findAdoptableEntry(TEST_SERVER, FILE);
    expect(entry?.content).toBe("a\nX\nc\n");
    useEditorStateStore.getState().openFile(KEY, TEST_SERVER, FILE);
    adoptOutboxEntry(KEY, entry!);
    expect(editor()?.state).toBe("diverged");
    expect(editor()?.diskContent).toBe("a\nY\nc\n");
    expect(outboxEntriesForTests().map((e) => e.status)).toEqual(["review"]);
  });

  test("closing the editor of a file deleted on disk keeps its queued edits", async () => {
    const { storage } = memoryStorage();
    await initSaveOutbox({ storage });
    const text = { current: "a\nb\nc\nd\n" };
    openEditor("a\nb\nc\n", text);
    serverDown = true;
    await saveEditorContent(FILE, text.current, REPO, undefined, KEY);
    delete disk[FILE]; // deleted by another program while the server was away
    serverDown = false;
    await retryQueuedSaves();
    expect(editor()?.deleted).toBe(true);
    text.current = "a\nb\nc\nd\ne\n"; // typed on, with autosave stopped by the deletion

    outboxEditorClosing(KEY, editor()!, REPO);
    useEditorStateStore.getState().closeFile(KEY);
    expect(opened).toEqual([]); // not reopened behind the user's back

    await reload(storage);
    expect(opened).toEqual([FILE]);
    expect(findAdoptableEntry(TEST_SERVER, FILE)?.content).toBe("a\nb\nc\nd\ne\n");
    // Given up only by the user: discarding them, or deleting the file in Loxel.
    forgetOutboxPath(TEST_SERVER, FILE);
    expect(outboxEntriesForTests()).toEqual([]);
  });
});

describe("deleted files", () => {
  test("edits typed after the file was deleted are kept when its tab closes", async () => {
    const text = { current: "a\nb\nc\n" };
    openEditor("a\nb\nc\n", text);
    const store = useEditorStateStore.getState();
    store.setDeleted(KEY, true);
    text.current = "a\nb\nc\nnew\n";
    store.markDirty(KEY);

    outboxEditorClosing(KEY, editor()!, REPO);
    store.closeFile(KEY);
    expect(outboxEntriesForTests().map((e) => [e.status, e.content])).toEqual([
      ["review", "a\nb\nc\nnew\n"],
    ]);
    expect(opened).toEqual([]);
  });

  test("a compare side of a deleted file gives its edits up when it closes", async () => {
    const side = viewEditorKey("compare-1:new");
    const store = useEditorStateStore.getState();
    store.openFile(side, TEST_SERVER, FILE);
    store.setBaseContent(side, "a\nb\nc\n");
    serverDown = true;
    await saveEditorContent(FILE, "a\nX\nc\n", REPO, undefined, side);
    store.setDeleted(side, true);

    outboxEditorClosing(side, useEditorStateStore.getState().files.get(side)!, REPO);
    expect(outboxEntriesForTests()).toEqual([]);
  });

  test("a clean editor of a deleted file leaves nothing behind", () => {
    openEditor("a\nb\nc\n", { current: "a\nb\nc\n" });
    useEditorStateStore.getState().setDeleted(KEY, true);
    outboxEditorClosing(KEY, editor()!, REPO);
    expect(outboxEntriesForTests()).toEqual([]);
  });
});

describe("recovered saves", () => {
  test("stay unmerged after a write the disk changed under", async () => {
    const { storage, stored } = memoryStorage();
    stored.set("e1", leftBehind());
    await initSaveOutbox({ storage });
    const entry = findAdoptableEntry(TEST_SERVER, FILE)!;
    const text = { current: entry.content };
    openEditor("a\nb\nc\n", text);
    adoptOutboxEntry(KEY, entry);
    afterNextRead = () => (disk[FILE] = "A\nb\nc\n");

    await retryQueuedSaves();
    // Read at its base, refused at the write, then read again: shown, not merged.
    expect(disk[FILE]).toBe("A\nb\nc\n");
    expect(editor()?.state).toBe("diverged");
    expect(outboxEntriesForTests().map((e) => e.status)).toEqual(["review"]);
  });
});

describe("a file another program keeps rewriting", () => {
  test("is retried a few times, then left to the backoff", async () => {
    const text = { current: "a\nb\nc\nd\n" };
    openEditor("a\nb\nc\n", text);
    serverDown = true;
    await saveEditorContent(FILE, text.current, REPO, undefined, KEY);
    serverDown = false;
    let rewrites = 0;
    onWrite = () => (disk[FILE] = `rewrite ${++rewrites}\n`);

    await retryQueuedSaves();
    expect(rewrites).toBe(3);
    expect(outboxEntriesForTests().map((e) => e.status)).toEqual(["queued"]);
  });
});

describe("storage", () => {
  test("every save is stored before it is sent, and forgotten once written", async () => {
    const { storage, stored } = memoryStorage();
    await initSaveOutbox({ storage });
    const storedWhenSent: number[] = [];
    onWrite = () => storedWhenSent.push(stored.size);
    const text = { current: "a\nb\nc\nd\n" };
    openEditor("a\nb\nc\n", text);

    await saveEditorContent(FILE, text.current, REPO, undefined, KEY);
    expect(storedWhenSent).toEqual([1]);
    expect(stored.size).toBe(0);
  });

  test("a save that cannot be stored is still sent, and the user is told", async () => {
    const { storage } = memoryStorage();
    storage.put = async () => {
      throw new Error("QuotaExceededError");
    };
    await initSaveOutbox({ storage });
    const text = { current: "a\nb\nc\nd\n" };
    openEditor("a\nb\nc\n", text);

    await saveEditorContent(FILE, text.current, REPO, undefined, KEY);
    await saveEditorContent(FILE, text.current, REPO, undefined, KEY);
    expect(disk[FILE]).toBe("a\nb\nc\nd\n");
    expect(toasts).toEqual([
      "Unsaved edits could not be stored: they are lost if Loxel closes before they are saved",
    ]);
  });
});

describe("retrying", () => {
  test("a change on disk between a retry's read and its write is merged, not overwritten", async () => {
    const text = { current: "a\nb\nc\nd\n" };
    openEditor("a\nb\nc\n", text);
    serverDown = true;
    await saveEditorContent(FILE, text.current, REPO, undefined, KEY);
    serverDown = false;
    afterNextRead = () => (disk[FILE] = "A\nb\nc\n");

    await retryQueuedSaves();
    expect(disk[FILE]).toBe("A\nb\nc\nd\n");
    expect(text.current).toBe("A\nb\nc\nd\n");
    expect(outboxEntriesForTests()).toEqual([]);
  });

  test("a closed editor's retry merges again when the disk changed before its write", async () => {
    const text = { current: "a\nb\nc\nd\n" };
    openEditor("a\nb\nc\n", text);
    serverDown = true;
    await saveEditorContent(FILE, text.current, REPO, undefined, KEY);
    useEditorStateStore.getState().closeFile(KEY);
    serverDown = false;
    afterNextRead = () => (disk[FILE] = "A\nb\nc\n");

    await retryQueuedSaves();
    expect(disk[FILE]).toBe("A\nb\nc\nd\n");
    expect(outboxEntriesForTests()).toEqual([]);
  });

  test("a queued save keeps its worktree subscribed until it is written", async () => {
    const text = { current: "a\nb\nc\nd\n" };
    openEditor("a\nb\nc\n", text);
    serverDown = true;
    await saveEditorContent(FILE, text.current, REPO, undefined, KEY);
    let drained = false;
    onWorktreeSavesDrained(REPO, () => (drained = true));
    expect(drained).toBe(false);

    serverDown = false;
    await retryQueuedSaves();
    expect(drained).toBe(true);
  });

  test("a worktree served again retries its saves at once", async () => {
    const text = { current: "a\nb\nc\nd\n" };
    openEditor("a\nb\nc\n", text);
    serverDown = true;
    await saveEditorContent(FILE, text.current, REPO, undefined, KEY);
    serverDown = false;

    dispatchLoxelEvent("loxel-worktree-files-resynced", { wt: REPO });
    await until(() => disk[FILE] === "a\nb\nc\nd\n");
  });

  test("recovered saves keep their worktree subscribed until written", async () => {
    const subscribe = spyOn(actualClient.wsClient, "subscribeWorktree");
    const unsubscribe = spyOn(actualClient.wsClient, "unsubscribeWorktree");
    try {
      const { storage, stored } = memoryStorage();
      stored.set("e1", leftBehind());
      await initSaveOutbox({ storage });
      expect(subscribe.mock.calls).toEqual([[REPO]]);
      expect(unsubscribe).not.toHaveBeenCalled();

      await retryQueuedSaves();
      expect(unsubscribe.mock.calls).toEqual([[REPO]]);
    } finally {
      subscribe.mockRestore();
      unsubscribe.mockRestore();
    }
  });
});

describe("queue", () => {
  test("a save for a path the server does not serve does not hold up the others", async () => {
    const other = "/gone/b.ts";
    const store = useEditorStateStore.getState();
    for (const path of [other, FILE]) {
      store.openFile(fileEditorKey(TEST_SERVER, path), TEST_SERVER, path);
      store.setBaseContent(fileEditorKey(TEST_SERVER, path), "a\n");
    }
    serverDown = true;
    // older, retried first
    await saveEditorContent(
      other,
      "a\nb\n",
      localRef("/gone"),
      undefined,
      fileEditorKey(TEST_SERVER, other),
    );
    await saveEditorContent(FILE, "a\nb\n", REPO, undefined, KEY);
    serverDown = false;
    unserved.add(other);
    disk[other] = "a\n";
    disk[FILE] = "a\n";

    await retryQueuedSaves();
    expect(disk[FILE]).toBe("a\nb\n");
    expect(outboxEntriesForTests().map((e) => [e.filePath, e.status])).toEqual([[other, "queued"]]);
  });
});

describe("a worktree that is gone", () => {
  async function queueSave(): Promise<void> {
    openEditor("a\nb\nc\n", { current: "a\nb\nc\nd\n" });
    serverDown = true;
    await saveEditorContent(FILE, "a\nb\nc\nd\n", REPO, undefined, KEY);
    serverDown = false;
  }

  const statuses = () => outboxEntriesForTests().map((entry) => entry.status);

  test("drops its saves when the user removed it in Loxel, and says so", async () => {
    await queueSave();
    useEditorStateStore.getState().closeFile(KEY);

    dispatchLoxelEvent("loxel-worktree-gone", { wt: REPO, discarded: true });
    expect(outboxEntriesForTests()).toEqual([]);
    expect(toasts).toEqual(["Unsaved edits to a.ts were discarded with their worktree"]);
    await retryQueuedSaves();
    expect(writes).toEqual([]);
  });

  test("the same path gone on another server settles none of this server's saves", async () => {
    await queueSave();

    dispatchLoxelEvent("loxel-worktree-gone", { wt: worktreeRef(THERE, "/repo"), discarded: true });

    expect(statuses()).toEqual(["queued"]);
    expect(toasts).toEqual([]);
  });

  test("keeps a save for review when it went any other way, neither retried nor holding it", async () => {
    await queueSave();
    let drained = false;
    onWorktreeSavesDrained(REPO, () => (drained = true));

    dispatchLoxelEvent("loxel-worktree-gone", { wt: REPO, discarded: false });
    expect(statuses()).toEqual(["review"]);
    expect(drained).toBe(true);
    await retryQueuedSaves();
    expect(writes).toEqual([]);
  });

  test("settles a save that fails after it went, instead of queuing it", async () => {
    openEditor("a\nb\nc\n", { current: "a\nb\nc\nd\n" });
    dispatchLoxelEvent("loxel-worktree-gone", { wt: REPO, discarded: false });
    serverDown = true;
    await saveEditorContent(FILE, "a\nb\nc\nd\n", REPO, undefined, KEY);
    expect(statuses()).toEqual(["review"]);
  });

  test("a removal in Loxel stays discarded when the list that follows it shows the worktree gone", async () => {
    openEditor("a\nb\nc\n", { current: "a\nb\nc\nd\n" });
    dispatchLoxelEvent("loxel-worktree-gone", { wt: REPO, discarded: true });
    dispatchLoxelEvent("loxel-worktree-gone", { wt: REPO, discarded: false });
    // The editor's unmount flush, sent after the server removed the worktree.
    serverDown = true;
    await saveEditorContent(FILE, "a\nb\nc\nd\n", REPO, undefined, KEY);
    expect(outboxEntriesForTests()).toEqual([]);
  });

  test("keeps retrying saves recovered at start under a project listed without worktrees", async () => {
    const subscribe = spyOn(actualClient.wsClient, "subscribeWorktree");
    const wt = "/proj/.worktrees/x";
    const file = `${wt}/a.ts`;
    try {
      // What the server lists for a project it could not initialize (a volume not mounted yet).
      projects = [
        {
          id: "p2",
          path: "/proj",
          name: "proj",
          addedAt: new Date(0).toISOString(),
          isBare: true,
          worktrees: [],
          worktreesDir: null,
          worktreeMetadata: false,
        },
      ];
      await useProjectStore.getState().fetchProjects();
      unserved.add(file);
      const { storage, stored } = memoryStorage();
      stored.set(
        "e1",
        leftBehind({
          worktreePath: wt,
          filePath: file,
          editorKey: fileEditorKey(TEST_SERVER, file),
        }),
      );

      await initSaveOutbox({ storage });
      await retryQueuedSaves();
      expect(outboxEntriesForTests().map((entry) => entry.status)).toEqual(["queued"]);
    } finally {
      subscribe.mockRestore();
      useProjectStore.setState({ projects: [] });
    }
  });

  test("keeps saves recovered at start for review once the projects no longer list it", async () => {
    const subscribe = spyOn(actualClient.wsClient, "subscribeWorktree");
    try {
      projects = [
        {
          id: "p1",
          path: "/other",
          name: "other",
          addedAt: new Date(0).toISOString(),
          isBare: false,
          worktrees: [],
          worktreesDir: null,
          worktreeMetadata: false,
        },
      ];
      await useProjectStore.getState().fetchProjects();
      unserved.add(FILE);
      const { storage, stored } = memoryStorage();
      stored.set("e1", leftBehind());

      await initSaveOutbox({ storage });
      await until(() => stored.get("e1")?.status === "review");
      await retryQueuedSaves();
      expect(writes).toEqual([]);
    } finally {
      subscribe.mockRestore();
      useProjectStore.setState({ projects: [] });
    }
  });
});

describe("unsavedFilesOf", () => {
  test("counts the worktree's unsaved editors and waiting saves, every window's, not those in flight", async () => {
    const { storage, stored } = memoryStorage();
    await initSaveOutbox({ storage });
    // This window: a save the server could not take, and an editor not saved yet.
    openEditor("a\nb\nc\n", { current: "a\nb\nc\nd\n" });
    serverDown = true;
    await saveEditorContent(FILE, "a\nb\nc\nd\n", REPO, undefined, KEY);
    const typed = fileEditorKey(TEST_SERVER, "/repo/typed.ts");
    useEditorStateStore.getState().openFile(typed, TEST_SERVER, "/repo/typed.ts");
    useEditorStateStore.getState().markDirty(typed);
    // Another window, still open: a save waiting, one in flight, and one of another worktree.
    const other = { ownerId: "other-window", status: "queued" } as const;
    stored.set("o1", leftBehind({ ...other, id: "o1", filePath: "/repo/queued.ts" }));
    stored.set(
      "o2",
      leftBehind({ ...other, id: "o2", filePath: "/repo/sending.ts", status: "sending" }),
    );
    stored.set("o3", leftBehind({ ...other, id: "o3", filePath: "/x/a.ts", worktreePath: "/x" }));

    expect((await unsavedFilesOf(TEST_SERVER, "/repo")).toSorted()).toEqual([
      FILE,
      "/repo/queued.ts",
      "/repo/typed.ts",
    ]);
  });

  test("counts another server's saves only for that server", async () => {
    const { storage, stored } = memoryStorage();
    await initSaveOutbox({ storage });
    const other = { ownerId: "other-window", status: "queued", server: THERE } as const;
    stored.set("o1", leftBehind({ ...other, id: "o1", filePath: "/repo/there.ts" }));

    expect(await unsavedFilesOf(TEST_SERVER, "/repo")).toEqual([]);
    expect(await unsavedFilesOf(THERE, "/repo")).toEqual(["/repo/there.ts"]);
  });
});
