import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";

import { until } from "@/test/until";

let toasts: string[] = [];
mock.module("@/components/ui/toast", () => ({
  showToast: (message: string) => toasts.push(message),
}));

let opened: string[] = [];
mock.module("@/lib/open-path", () => ({
  openFile: async ({ filePath }: { filePath: string }) => {
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
const actualClient = await import("@/api/client");
mock.module("@/api/client", () => ({
  ...actualClient,
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
} = await import("./save-outbox");
const { dispatchLoxelEvent } = await import("./loxel-events");
type OutboxEntry = import("./save-outbox").OutboxEntry;
type OutboxStorage = import("./save-outbox").OutboxStorage;
const { useEditorStateStore } = await import("@/store/editor-state");

const FILE = "/repo/a.ts";

/** Open an editor of FILE that loaded `content` and now shows `editorText`. */
function openEditor(content: string, editorText: { current: string }): void {
  const store = useEditorStateStore.getState();
  store.openFile(FILE);
  store.setBaseContent(FILE, content);
  store.registerEditorCallbacks(
    FILE,
    () => editorText.current,
    (merged) => {
      editorText.current = merged;
      return merged;
    },
  );
  store.registerPendingEdit(FILE, () => ({ content: editorText.current }));
}

function editor() {
  return useEditorStateStore.getState().files.get(FILE);
}

/** Storage that keeps copies of the entries, as IndexedDB does, across "reloads" of the outbox. */
function memoryStorage(): { storage: OutboxStorage; stored: Map<string, OutboxEntry> } {
  const stored = new Map<string, OutboxEntry>();
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
    editorKey: FILE,
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

    expect(await saveEditorContent(FILE, text.current, "/repo")).toBe(false);
    expect(editor()?.state).toBe("dirty");
    expect(editor()?.queued).toBe(true);

    serverDown = false;
    await retryQueuedSaves();
    expect(disk[FILE]).toBe("a\nb\nc\nd\n");
    expect(editor()?.queued).toBe(false);
    expect(outboxEntriesForTests()).toEqual([]);
  });

  test("a refused save is not queued", async () => {
    const text = { current: "a\nb\nc\nd\n" };
    openEditor("a\nb\nc\n", text);
    refuseWrites = true;

    expect(await saveEditorContent(FILE, text.current, "/repo")).toBe(false);
    expect(editor()?.queued).toBe(false);
    expect(outboxEntriesForTests()).toEqual([]);
  });

  test("later saves wait behind a queued one, and the retry sends the newest", async () => {
    const text = { current: "a\nb\nc\nd\n" };
    openEditor("a\nb\nc\n", text);
    serverDown = true;
    await saveEditorContent(FILE, text.current, "/repo");

    serverDown = false;
    disk[FILE] = "A\nb\nc\n"; // another program edits the file meanwhile
    text.current = "a\nb\nc\nd\ne\n";
    // Not written blindly over the other program's edit: it waits for the retry's merge.
    void saveEditorContent(FILE, text.current, "/repo");
    expect(writes).toEqual([]);

    await retryQueuedSaves();
    expect(disk[FILE]).toBe("A\nb\nc\nd\ne\n");
    expect(text.current).toBe("A\nb\nc\nd\ne\n");
  });

  test("a retry that conflicts with the disk leaves the editor diverged, not overwritten", async () => {
    const text = { current: "a\nX\nc\n" };
    openEditor("a\nb\nc\n", text);
    serverDown = true;
    await saveEditorContent(FILE, text.current, "/repo");

    serverDown = false;
    disk[FILE] = "a\nY\nc\n";
    await retryQueuedSaves();
    expect(disk[FILE]).toBe("a\nY\nc\n");
    expect(editor()?.state).toBe("diverged");
    expect(outboxEntriesForTests().map((e) => e.status)).toEqual(["review"]);

    // Accepting the disk version gives up the edits.
    useEditorStateStore.getState().acceptDiskVersion(FILE);
    expect(outboxEntriesForTests()).toEqual([]);
  });

  test("a retry sends what the editor shows now, not the older queued content", async () => {
    const text = { current: "a\nb\nc\nd\n" };
    openEditor("a\nb\nc\n", text);
    serverDown = true;
    await saveEditorContent(FILE, text.current, "/repo");
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
      .registerPendingEdit(FILE, () => ({ content: text.current, options: { format: true } }));
    serverDown = true;
    await saveEditorContent(FILE, text.current, "/repo"); // an autosave: no format options

    serverDown = false;
    await retryQueuedSaves();
    expect(writes.at(-1)?.format).toBeUndefined();
  });

  test("a second external change does not undo edits kept through the first", async () => {
    const text = { current: "USER\nb\nc\nd\ne\n" };
    openEditor("a\nb\nc\nd\ne\n", text);
    const store = useEditorStateStore.getState();
    store.markDirty(FILE);
    store.handleDiskChange(FILE, [], "a\nb\nc\nd\nB\n");
    expect(text.current).toBe("USER\nb\nc\nd\nB\n");
    store.handleDiskChange(FILE, [], "a\nb\nC\nd\nB\n");
    expect(text.current).toBe("USER\nb\nC\nd\nB\n");
  });

  test("a save confirmed without its echo is the base of the next one", async () => {
    const text = { current: "a\nb1\nc\n" };
    openEditor("a\nb\nc\n", text);
    await saveEditorContent(FILE, text.current, "/repo"); // written; its echo never comes
    useEditorStateStore.getState().handleSaveError(FILE, [...editor()!.pendingNonces][0]!);

    text.current = "a\nb12\nc\n";
    serverDown = true;
    await saveEditorContent(FILE, text.current, "/repo");
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
    await saveEditorContent(FILE, content, "/repo");
    useEditorStateStore.getState().closeFile(FILE);
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
    const side = "compare-1:new";
    const store = useEditorStateStore.getState();
    store.openFile(side, FILE);
    store.setBaseContent(side, "a\nb\nc\n");
    serverDown = true;
    await saveEditorContent(FILE, "a\nX\nc\n", "/repo", undefined, side);
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

    const entry = findAdoptableEntry(FILE);
    expect(entry?.content).toBe("a\nX\nc\n");
    useEditorStateStore.getState().openFile(FILE);
    adoptOutboxEntry(FILE, entry!);
    expect(editor()?.state).toBe("diverged");
    expect(editor()?.diskContent).toBe("a\nY\nc\n");
    expect(findAdoptableEntry(FILE)).toBeNull();
  });

  test("a reopened tab takes over a save still waiting, as unsaved edits", async () => {
    await queueAndClose("a\nb\nc\n", "a\nb\nc\nd\n");
    const entry = findAdoptableEntry(FILE);
    useEditorStateStore.getState().openFile(FILE);
    adoptOutboxEntry(FILE, entry!);
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

  test("the entries of a window still open are left to it", async () => {
    const { storage, stored } = memoryStorage();
    stored.set("e1", leftBehind({ ownerId: "open-window" }));
    stored.set("e2", leftBehind({ id: "e2", filePath: "/repo/b.ts", editorKey: "/repo/b.ts" }));
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
    await saveEditorContent(FILE, text.current, "/repo");
    serverDown = false;
    disk[FILE] = "a\nY\nc\n";
    await retryQueuedSaves();
    expect(editor()?.state).toBe("diverged");

    await reload(storage);
    expect(opened).toEqual([FILE]);
    const entry = findAdoptableEntry(FILE);
    expect(entry?.content).toBe("a\nX\nc\n");
    useEditorStateStore.getState().openFile(FILE);
    adoptOutboxEntry(FILE, entry!);
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
    await saveEditorContent(FILE, text.current, "/repo");
    delete disk[FILE]; // deleted by another program while the server was away
    serverDown = false;
    await retryQueuedSaves();
    expect(editor()?.deleted).toBe(true);
    text.current = "a\nb\nc\nd\ne\n"; // typed on, with autosave stopped by the deletion

    outboxEditorClosing(FILE, editor()!, "/repo");
    useEditorStateStore.getState().closeFile(FILE);
    expect(opened).toEqual([]); // not reopened behind the user's back

    await reload(storage);
    expect(opened).toEqual([FILE]);
    expect(findAdoptableEntry(FILE)?.content).toBe("a\nb\nc\nd\ne\n");
    // Given up only by the user: discarding them, or deleting the file in Loxel.
    forgetOutboxPath(FILE);
    expect(outboxEntriesForTests()).toEqual([]);
  });
});

describe("deleted files", () => {
  test("edits typed after the file was deleted are kept when its tab closes", async () => {
    const text = { current: "a\nb\nc\n" };
    openEditor("a\nb\nc\n", text);
    const store = useEditorStateStore.getState();
    store.setDeleted(FILE, true);
    text.current = "a\nb\nc\nnew\n";
    store.markDirty(FILE);

    outboxEditorClosing(FILE, editor()!, "/repo");
    store.closeFile(FILE);
    expect(outboxEntriesForTests().map((e) => [e.status, e.content])).toEqual([
      ["review", "a\nb\nc\nnew\n"],
    ]);
    expect(opened).toEqual([]);
  });

  test("a compare side of a deleted file gives its edits up when it closes", async () => {
    const side = "compare-1:new";
    const store = useEditorStateStore.getState();
    store.openFile(side, FILE);
    store.setBaseContent(side, "a\nb\nc\n");
    serverDown = true;
    await saveEditorContent(FILE, "a\nX\nc\n", "/repo", undefined, side);
    store.setDeleted(side, true);

    outboxEditorClosing(side, useEditorStateStore.getState().files.get(side)!, "/repo");
    expect(outboxEntriesForTests()).toEqual([]);
  });

  test("a clean editor of a deleted file leaves nothing behind", () => {
    openEditor("a\nb\nc\n", { current: "a\nb\nc\n" });
    useEditorStateStore.getState().setDeleted(FILE, true);
    outboxEditorClosing(FILE, editor()!, "/repo");
    expect(outboxEntriesForTests()).toEqual([]);
  });
});

describe("recovered saves", () => {
  test("stay unmerged after a write the disk changed under", async () => {
    const { storage, stored } = memoryStorage();
    stored.set("e1", leftBehind());
    await initSaveOutbox({ storage });
    const entry = findAdoptableEntry(FILE)!;
    const text = { current: entry.content };
    openEditor("a\nb\nc\n", text);
    adoptOutboxEntry(FILE, entry);
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
    await saveEditorContent(FILE, text.current, "/repo");
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

    await saveEditorContent(FILE, text.current, "/repo");
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

    await saveEditorContent(FILE, text.current, "/repo");
    await saveEditorContent(FILE, text.current, "/repo");
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
    await saveEditorContent(FILE, text.current, "/repo");
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
    await saveEditorContent(FILE, text.current, "/repo");
    useEditorStateStore.getState().closeFile(FILE);
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
    await saveEditorContent(FILE, text.current, "/repo");
    let drained = false;
    onWorktreeSavesDrained("/repo", () => (drained = true));
    expect(drained).toBe(false);

    serverDown = false;
    await retryQueuedSaves();
    expect(drained).toBe(true);
  });

  test("a worktree served again retries its saves at once", async () => {
    const text = { current: "a\nb\nc\nd\n" };
    openEditor("a\nb\nc\n", text);
    serverDown = true;
    await saveEditorContent(FILE, text.current, "/repo");
    serverDown = false;

    dispatchLoxelEvent("loxel-worktree-files-resynced", { wtPath: "/repo" });
    await until(() => disk[FILE] === "a\nb\nc\nd\n");
  });

  test("recovered saves keep their worktree subscribed until written", async () => {
    const subscribe = spyOn(actualClient.wsClient, "subscribeWorktree");
    const unsubscribe = spyOn(actualClient.wsClient, "unsubscribeWorktree");
    try {
      const { storage, stored } = memoryStorage();
      stored.set("e1", leftBehind());
      await initSaveOutbox({ storage });
      expect(subscribe.mock.calls).toEqual([["/repo"]]);
      expect(unsubscribe).not.toHaveBeenCalled();

      await retryQueuedSaves();
      expect(unsubscribe.mock.calls).toEqual([["/repo"]]);
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
      store.openFile(path);
      store.setBaseContent(path, "a\n");
    }
    serverDown = true;
    await saveEditorContent(other, "a\nb\n", "/gone"); // older, retried first
    await saveEditorContent(FILE, "a\nb\n", "/repo");
    serverDown = false;
    unserved.add(other);
    disk[other] = "a\n";
    disk[FILE] = "a\n";

    await retryQueuedSaves();
    expect(disk[FILE]).toBe("a\nb\n");
    expect(outboxEntriesForTests().map((e) => [e.filePath, e.status])).toEqual([[other, "queued"]]);
  });
});
