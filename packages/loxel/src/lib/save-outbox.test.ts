import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

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
let writes: Array<{ path: string; content: string }> = [];
let serverDown = false;
let refuseWrites = false;
/** Paths the server answers with a plain 404, as for a worktree it has no resources for. */
let unserved = new Set<string>();
const actualClient = await import("@/api/client");
mock.module("@/api/client", () => ({
  ...actualClient,
  getFileContentByPath: async (path: string) => {
    if (serverDown) throw new TypeError("Failed to fetch");
    if (unserved.has(path)) throw new actualClient.ApiError("Not in any worktree", 404);
    const content = disk[path];
    if (content === undefined) throw new actualClient.ApiError("File not found", 404, "ENOENT");
    return { content };
  },
  writeFileContent: async (options: { path: string; content: string }) => {
    if (serverDown) throw new TypeError("Failed to fetch");
    if (refuseWrites) throw new actualClient.ApiError("Permission denied", 500);
    writes.push({ path: options.path, content: options.content });
    disk[options.path] = options.content;
    return { success: true, content: options.content };
  },
}));

const { saveEditorContent } = await import("./save-editor-content");
const {
  adoptOutboxEntry,
  findAdoptableEntry,
  initSaveOutbox,
  isRetriableSaveError,
  outboxEntriesForTests,
  resetSaveOutboxForTests,
  retryQueuedSaves,
} = await import("./save-outbox");
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

beforeEach(() => {
  toasts = [];
  opened = [];
  disk = { [FILE]: "a\nb\nc\n" };
  writes = [];
  serverDown = false;
  refuseWrites = false;
  unserved = new Set();
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
    const stored = {
      id: "e1",
      instanceId: "gone-editor",
      ownerId: "gone-window",
      editorKey: FILE,
      filePath: FILE,
      worktreePath: "/repo",
      base: "a\nb\nc\n",
      content: "a\nb\nc\nd\n",
      seq: 1,
      status: "sending" as const,
      disk: null,
    };
    const removed: string[] = [];
    await initSaveOutbox({
      storage: { load: async () => [stored], put: () => {}, remove: (id) => removed.push(id) },
    });
    await retryQueuedSaves();
    expect(disk[FILE]).toBe("a\nb\nc\nd\n");
    expect(removed).toEqual(["e1"]);
    expect(toasts).toEqual(["Saved edits from the last session to a.ts"]);
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

describe("storage", () => {
  test("a save in flight from an open editor is stored only once it fails or its editor closes", async () => {
    const stored = new Map<string, string>();
    await initSaveOutbox({
      storage: {
        load: async () => [],
        put: (entry) => stored.set(entry.id, entry.status),
        remove: (id) => stored.delete(id),
      },
    });
    const text = { current: "a\nb\nc\nd\n" };
    openEditor("a\nb\nc\n", text);

    await saveEditorContent(FILE, text.current, "/repo");
    expect(stored.size).toBe(0); // confirmed at once, never stored

    serverDown = true;
    await saveEditorContent(FILE, text.current, "/repo");
    expect([...stored.values()]).toEqual(["queued"]);

    serverDown = false;
    await retryQueuedSaves();
    expect(stored.size).toBe(0);
  });
});
