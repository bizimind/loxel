import { afterEach, describe, expect, mock, test } from "bun:test";

import { DockviewApi, DockviewComponent } from "dockview-react";

// The editors' module-level caches pull in Milkdown and Excalidraw; the move only needs to call them.
mock.module("@/components/editor/MarkdownEditor", () => ({
  renameEditorCacheKey: () => {},
  setEditorContent: () => {},
}));
mock.module("@/components/excalidraw-editor/ExcalidrawEditor", () => ({
  renameDrawingCacheKey: () => {},
}));

let toasts: string[] = [];
mock.module("@/components/ui/toast", () => ({
  showToast: (message: string) => toasts.push(message),
}));

// The moved file's content on disk, and the writes the move makes.
let diskContent: Record<string, string> = {};
let writes: Array<{ path: string; content: string }> = [];
let failWrites = false;
const actualClient = await import("@/api/client");
mock.module("@/api/client", () => ({
  ...actualClient,
  getFileContentByPath: async (path: string) => {
    const content = diskContent[path];
    if (content === undefined) throw new actualClient.ApiError("File not found", 404, "ENOENT");
    return { content };
  },
  writeFileContent: async (options: { path: string; content: string }) => {
    if (failWrites) throw new Error("write failed");
    writes.push({ path: options.path, content: options.content });
    return { success: true };
  },
}));

const { createTerminal, handleFileMoved, openBrowserTab, openFileBacked } =
  await import("./panel-creators");
const { setCenterApi } = await import("@/store/tools-bar");
const { useEditorStateStore } = await import("@/store/editor-state");

/** A center dockview with two groups: `left` (a.ts, b.ts) and `right` (c.ts). */
function setup() {
  const element = document.createElement("div");
  document.body.append(element);
  const dockview = new DockviewComponent(element, {
    createComponent: () => ({ element: document.createElement("div"), init: () => {} }),
  });
  dockview.layout(800, 600);
  const api = new DockviewApi(dockview);
  const addFile = (
    filePath: string,
    position?: Parameters<DockviewApi["addPanel"]>[0]["position"],
  ) =>
    api.addPanel({
      id: `codeeditor-${filePath}`,
      component: "codeEditor",
      params: { filePath },
      title: filePath.split("/").pop(),
      position,
    });
  const a = addFile("/repo/a.ts");
  const b = addFile("/repo/b.ts", { referencePanel: a.id, direction: "within" });
  const c = addFile("/repo/c.ts", { referencePanel: a.id, direction: "right" });
  setCenterApi(api);
  return { api, a, b, c };
}

function tabIds(api: DockviewApi, groupIndex: number) {
  return api.groups[groupIndex]!.panels.map((p) => p.id);
}

afterEach(() => {
  setCenterApi(null);
  document.body.innerHTML = "";
  useEditorStateStore.setState({ files: new Map() });
  diskContent = {};
  writes = [];
  failWrites = false;
  toasts = [];
});

describe("handleFileMoved", () => {
  test("replaces a background tab in place without activating it", async () => {
    const { api, a, c } = setup();
    a.api.setActive();
    expect(api.activePanel?.id).toBe("codeeditor-/repo/a.ts");

    await handleFileMoved("/repo/b.ts", "/repo/renamed.ts");

    expect(tabIds(api, 0)).toEqual(["codeeditor-/repo/a.ts", "codeeditor-/repo/renamed.ts"]);
    expect(api.activePanel?.id).toBe("codeeditor-/repo/a.ts");
    expect(c.group.activePanel?.id).toBe("codeeditor-/repo/c.ts");
  });

  test("keeps a renamed active tab active", async () => {
    const { api, a } = setup();
    a.api.setActive();

    await handleFileMoved("/repo/a.ts", "/repo/renamed.ts");

    expect(tabIds(api, 0)).toEqual(["codeeditor-/repo/renamed.ts", "codeeditor-/repo/b.ts"]);
    expect(api.activePanel?.id).toBe("codeeditor-/repo/renamed.ts");
  });

  test("shows the renamed tab in an inactive group without activating that group", async () => {
    const { api, b, c } = setup();
    b.api.setActive();
    c.api.setActive();
    expect(api.activeGroup).toBe(c.group);

    await handleFileMoved("/repo/b.ts", "/repo/renamed.ts");

    const left = api.groups[0]!;
    expect(left.activePanel?.id).toBe("codeeditor-/repo/renamed.ts");
    expect(api.activeGroup).toBe(c.group);
    expect(api.activePanel?.id).toBe("codeeditor-/repo/c.ts");
  });

  test("keeps a group that held only the renamed tab", async () => {
    const { api } = setup();

    await handleFileMoved("/repo/c.ts", "/repo/renamed.ts");

    expect(api.groups).toHaveLength(2);
    expect(tabIds(api, 1)).toEqual(["codeeditor-/repo/renamed.ts"]);
  });

  test("drops the old tab when the new path is already open", async () => {
    const { api, a } = setup();
    a.api.setActive();

    await handleFileMoved("/repo/b.ts", "/repo/c.ts");

    expect(tabIds(api, 0)).toEqual(["codeeditor-/repo/a.ts"]);
    expect(tabIds(api, 1)).toEqual(["codeeditor-/repo/c.ts"]);
    expect(api.activePanel?.id).toBe("codeeditor-/repo/a.ts");
  });

  test("marks the old editor entry as moving while the tab is replaced", async () => {
    setup();
    useEditorStateStore.getState().openFile("/repo/b.ts");

    expect(await handleFileMoved("/repo/b.ts", "/repo/renamed.ts")).toBe(true);

    expect(useEditorStateStore.getState().files.get("/repo/b.ts")?.movedTo).toBe(
      "/repo/renamed.ts",
    );
  });

  /** An open, dirty editor on `/repo/b.ts` whose last clean content was `base`. */
  function dirtyEditor(base: string, edited: string) {
    const store = useEditorStateStore.getState();
    store.openFile("/repo/b.ts");
    store.setBaseContent("/repo/b.ts", base);
    store.markDirty("/repo/b.ts");
    store.registerPendingEdit("/repo/b.ts", () => ({ content: edited }));
  }

  test("writes unsaved edits to the new path when the file there is unchanged", async () => {
    setup();
    dirtyEditor("a\nb\n", "a\nb\nmine\n");
    diskContent["/repo/renamed.ts"] = "a\nb\n";

    expect(await handleFileMoved("/repo/b.ts", "/repo/renamed.ts")).toBe(true);
    await Bun.sleep(0);

    expect(writes).toEqual([{ path: "/repo/renamed.ts", content: "a\nb\nmine\n" }]);
  });

  test("merges unsaved edits onto a change made at the new path after the move", async () => {
    setup();
    dirtyEditor("a\nb\nc\n", "a\nb\nc\nmine\n");
    diskContent["/repo/renamed.ts"] = "theirs\na\nb\nc\n";

    expect(await handleFileMoved("/repo/b.ts", "/repo/renamed.ts")).toBe(true);
    await Bun.sleep(0);

    expect(writes).toEqual([{ path: "/repo/renamed.ts", content: "theirs\na\nb\nc\nmine\n" }]);
  });

  test("leaves the tab on its old path, shown deleted, when the edits conflict", async () => {
    const { api } = setup();
    dirtyEditor("a\n", "mine\n");
    diskContent["/repo/renamed.ts"] = "theirs\n";

    expect(await handleFileMoved("/repo/b.ts", "/repo/renamed.ts")).toBe(false);

    expect(writes).toEqual([]);
    expect(api.getPanel("codeeditor-/repo/b.ts")).toBeDefined();
    expect(api.getPanel("codeeditor-/repo/renamed.ts")).toBeUndefined();
    const entry = useEditorStateStore.getState().files.get("/repo/b.ts");
    expect(entry?.movedTo).toBeNull();
    expect(entry?.deleted).toBe(true);
  });

  test("keeps a tab with unsaved edits when the new path is already open", async () => {
    const { api } = setup();
    dirtyEditor("a\n", "a\nmine\n");

    expect(await handleFileMoved("/repo/b.ts", "/repo/c.ts")).toBe(false);

    expect(writes).toEqual([]);
    expect(api.getPanel("codeeditor-/repo/b.ts")).toBeDefined();
    expect(api.getPanel("codeeditor-/repo/c.ts")).toBeDefined();
    const entry = useEditorStateStore.getState().files.get("/repo/b.ts");
    expect(entry?.deleted).toBe(true);
    expect(entry?.movedTo).toBeNull();
  });

  test("keeps the tab and its edits when writing them to the new path fails", async () => {
    const { api } = setup();
    dirtyEditor("a\n", "a\nmine\n");
    diskContent["/repo/renamed.ts"] = "a\n";
    failWrites = true;

    expect(await handleFileMoved("/repo/b.ts", "/repo/renamed.ts")).toBe(false);

    expect(api.getPanel("codeeditor-/repo/b.ts")).toBeDefined();
    expect(api.getPanel("codeeditor-/repo/renamed.ts")).toBeUndefined();
    const entry = useEditorStateStore.getState().files.get("/repo/b.ts");
    expect(entry?.movedTo).toBeNull();
    expect(entry?.deleted).toBe(true);
  });

  test("does not overwrite a changed new path when the editor has no merge base", async () => {
    const { api } = setup();
    const store = useEditorStateStore.getState();
    // Typed into before its first load resolved: dirty, but never reconciled with disk.
    store.openFile("/repo/b.ts");
    store.markDirty("/repo/b.ts");
    store.registerPendingEdit("/repo/b.ts", () => ({ content: "mine\n" }));
    diskContent["/repo/renamed.ts"] = "theirs\n";

    expect(await handleFileMoved("/repo/b.ts", "/repo/renamed.ts")).toBe(false);

    expect(writes).toEqual([]);
    expect(api.getPanel("codeeditor-/repo/b.ts")).toBeDefined();
    expect(useEditorStateStore.getState().files.get("/repo/b.ts")?.deleted).toBe(true);
  });

  test("treats a save of ours that landed before the move as our own version", async () => {
    setup();
    dirtyEditor("a\n", "a\nmore\nmore again\n");
    const store = useEditorStateStore.getState();
    store.registerEditorCallbacks(
      "/repo/b.ts",
      () => "a\nmore\n",
      () => null,
    );
    store.markSaving("/repo/b.ts", "n1"); // snapshot "a\nmore\n", written before the move
    diskContent["/repo/renamed.ts"] = "a\nmore\n";

    expect(await handleFileMoved("/repo/b.ts", "/repo/renamed.ts")).toBe(true);
    await Bun.sleep(0);

    expect(writes).toEqual([{ path: "/repo/renamed.ts", content: "a\nmore\nmore again\n" }]);
  });

  test("handles the same move once when it is reported twice at the same time", async () => {
    const { api } = setup();
    dirtyEditor("a\n", "a\nmine\n");
    diskContent["/repo/renamed.ts"] = "a\n";

    const results = await Promise.all([
      handleFileMoved("/repo/b.ts", "/repo/renamed.ts"),
      handleFileMoved("/repo/b.ts", "/repo/renamed.ts", { announce: true }),
    ]);

    expect(results).toEqual([true, false]);
    expect(writes).toHaveLength(1);
    expect(api.getPanel("codeeditor-/repo/renamed.ts")?.params?.movedFrom).toBeUndefined();
  });

  test("closes the old entry when the new path is already open, and reports no replacement", async () => {
    setup();
    useEditorStateStore.getState().openFile("/repo/b.ts");

    expect(await handleFileMoved("/repo/b.ts", "/repo/c.ts")).toBe(false);

    expect(useEditorStateStore.getState().files.has("/repo/b.ts")).toBe(false);
  });

  test("records the old path on the new tab only when the move is announced", async () => {
    const { api } = setup();

    await handleFileMoved("/repo/b.ts", "/repo/renamed.ts", { announce: true });
    await handleFileMoved("/repo/c.ts", "/repo/quiet.ts");

    expect(api.getPanel("codeeditor-/repo/renamed.ts")?.params?.movedFrom).toBe("/repo/b.ts");
    expect(api.getPanel("codeeditor-/repo/quiet.ts")?.params?.movedFrom).toBeUndefined();
  });

  test("leaves a tab in conflict on its old path, without writing anything", async () => {
    const { api } = setup();
    const store = useEditorStateStore.getState();
    store.openFile("/repo/b.ts");
    store.markDirty("/repo/b.ts");
    store.handleDiskChange("/repo/b.ts", [], "theirs");
    expect(useEditorStateStore.getState().files.get("/repo/b.ts")?.state).toBe("diverged");

    expect(await handleFileMoved("/repo/b.ts", "/repo/renamed.ts")).toBe(false);

    expect(api.getPanel("codeeditor-/repo/b.ts")).toBeDefined();
    expect(api.getPanel("codeeditor-/repo/renamed.ts")).toBeUndefined();
    expect(writes).toEqual([]);
  });

  test("is a no-op for a path with no tab", async () => {
    setup();
    expect(await handleFileMoved("/repo/none.ts", "/repo/renamed.ts")).toBe(false);
  });
});

describe("placement", () => {
  const ids = (panels: { id: string }[]) => panels.map((p) => p.id);

  test("a new panel opens as a tab in the active tab's group by default", () => {
    const { api, a } = setup();
    a.api.setActive();

    createTerminal({ terminalId: "t" });

    expect(ids(a.group.panels)).toEqual([a.id, "codeeditor-/repo/b.ts", "terminal-t"]);
    expect(api.activePanel?.id).toBe("terminal-t");
  });

  test("split opens a new group beside the active tab", () => {
    const { api, a } = setup();
    a.api.setActive();

    createTerminal({ terminalId: "t", placement: { split: "down" } });

    const terminal = api.getPanel("terminal-t")!;
    expect(api.groups).toHaveLength(3);
    expect(ids(terminal.group.panels)).toEqual(["terminal-t"]);
    expect(ids(a.group.panels)).toEqual([a.id, "codeeditor-/repo/b.ts"]);
  });

  test("group names a tab by title or by file path", () => {
    const { api, a, c } = setup();
    a.api.setActive();

    createTerminal({ terminalId: "t1", placement: { group: { name: "c.ts" } } });
    createTerminal({
      terminalId: "t2",
      placement: { group: { name: "missing", path: "/repo/c.ts" } },
    });

    expect(ids(c.group.panels)).toEqual([c.id, "terminal-t1", "terminal-t2"]);
    expect(api.activePanel?.id).toBe("terminal-t2");
    expect(toasts).toEqual([]);
  });

  test("a group naming no open tab falls back to the active tab, with a toast", () => {
    const { a } = setup();
    a.api.setActive();

    createTerminal({ terminalId: "t", placement: { group: { name: "nope" } } });

    expect(ids(a.group.panels)).toContain("terminal-t");
    expect(toasts).toEqual([`No open tab matches "nope"; placed by the active tab instead`]);
  });

  test("replace takes the reference tab's place and closes it", () => {
    const { api, a, c } = setup();
    a.api.setActive();

    createTerminal({ terminalId: "t", placement: { replace: true } });
    expect(ids(api.groups[0]!.panels)).toEqual(["terminal-t", "codeeditor-/repo/b.ts"]);

    createTerminal({ terminalId: "u", placement: { replace: true, group: { name: "c.ts" } } });
    expect(api.getPanel(c.id)).toBeUndefined();
    expect(ids(api.groups[1]!.panels)).toEqual(["terminal-u"]);
  });

  test("an open file's tab is moved where the placement asks", () => {
    const { api, a, c } = setup();
    a.api.setActive();

    openFileBacked("codeEditor", "/repo/c.ts", { placement: { group: { name: "a.ts" } } });

    expect(api.groups).toHaveLength(1);
    expect(ids(a.group.panels)).toEqual([a.id, "codeeditor-/repo/b.ts", c.id]);
    expect(api.activePanel?.id).toBe(c.id);
  });

  test("an open file's tab splits off or replaces the reference tab", () => {
    const { api, a, c } = setup();
    a.api.setActive();

    openFileBacked("codeEditor", "/repo/b.ts", { placement: { split: "right" } });
    const b = api.getPanel("codeeditor-/repo/b.ts")!;
    expect(api.groups).toHaveLength(3);
    expect(ids(b.group.panels)).toEqual([b.id]);
    expect(ids(a.group.panels)).toEqual([a.id]);

    openFileBacked("codeEditor", "/repo/b.ts", {
      placement: { replace: true, group: { name: "c.ts" } },
    });
    expect(api.getPanel(c.id)).toBeUndefined();
    expect(ids(api.getPanel(b.id)!.group.panels)).toEqual([b.id]);
    expect(api.activePanel?.id).toBe(b.id);
  });

  test("a tab placed relative to itself stays put unless split off its group", () => {
    const { api, a, c } = setup();
    a.api.setActive();

    openFileBacked("codeEditor", "/repo/a.ts", { placement: { replace: true } });
    expect(ids(a.group.panels)).toEqual([a.id, "codeeditor-/repo/b.ts"]);
    expect(api.activePanel?.id).toBe(a.id);

    c.api.setActive();
    openFileBacked("codeEditor", "/repo/c.ts", { placement: { split: "down" } });
    expect(api.groups).toHaveLength(2);
    expect(ids(api.getPanel(c.id)!.group.panels)).toEqual([c.id]);

    openFileBacked("codeEditor", "/repo/a.ts", { placement: { split: "up" } });
    expect(api.groups).toHaveLength(3);
    expect(ids(api.getPanel(a.id)!.group.panels)).toEqual([a.id]);
    expect(api.activePanel?.id).toBe(a.id);
  });

  test("without focus a new panel opens in the background, leaving the active tab and group", () => {
    const { api, a, c } = setup();
    a.api.setActive();

    createTerminal({ terminalId: "t", focus: false });
    expect(ids(a.group.panels)).toEqual([a.id, "codeeditor-/repo/b.ts", "terminal-t"]);
    expect(api.activePanel?.id).toBe(a.id);

    createTerminal({ terminalId: "u", focus: false, placement: { group: { name: "c.ts" } } });
    expect(ids(c.group.panels)).toEqual([c.id, "terminal-u"]);
    expect(c.group.activePanel?.id).toBe(c.id);
    expect(api.activePanel?.id).toBe(a.id);
  });

  test("without focus a split shows the panel in its new group but keeps the active group", () => {
    const { api, a } = setup();
    a.api.setActive();

    createTerminal({ terminalId: "t", focus: false, placement: { split: "down" } });

    const terminal = api.getPanel("terminal-t")!;
    expect(terminal.group.activePanel).toBe(terminal);
    expect(api.activeGroup).toBe(a.group);
    expect(api.activePanel?.id).toBe(a.id);
  });

  test("without focus an open file's tab is neither activated nor, unplaced, moved", () => {
    const { api, a, c } = setup();
    a.api.setActive();

    openFileBacked("codeEditor", "/repo/b.ts", { focus: false });
    expect(api.activePanel?.id).toBe(a.id);
    expect(a.group.activePanel?.id).toBe(a.id);

    openFileBacked("codeEditor", "/repo/c.ts", {
      focus: false,
      placement: { group: { name: "a.ts" } },
    });
    expect(ids(a.group.panels)).toContain(c.id);
    expect(api.activeGroup).toBe(a.group);
  });

  test("without focus a replace in another group keeps the active tab", () => {
    const { api, a, c } = setup();
    a.api.setActive();

    createTerminal({
      terminalId: "t",
      focus: false,
      placement: { replace: true, group: { name: "c.ts" } },
    });

    expect(api.getPanel(c.id)).toBeUndefined();
    expect(api.activeGroup).toBe(a.group);
    expect(api.activePanel?.id).toBe(a.id);

    openFileBacked("codeEditor", "/repo/b.ts", {
      focus: false,
      placement: { replace: true, group: { name: "Terminal" } },
    });
    expect(api.getPanel("terminal-t")).toBeUndefined();
    expect(api.activePanel?.id).toBe(a.id);
  });

  test("without focus an open tab split off elsewhere keeps the active tab and group", () => {
    const { api, a, c } = setup();
    c.api.setActive();

    openFileBacked("codeEditor", "/repo/b.ts", { focus: false, placement: { split: "right" } });

    const b = api.getPanel("codeeditor-/repo/b.ts")!;
    expect(ids(b.group.panels)).toEqual([b.id]);
    expect(b.group.activePanel).toBe(b);
    expect(api.activePanel).toBe(c);
    expect(api.activeGroup).toBe(c.group);

    openFileBacked("codeEditor", "/repo/a.ts", {
      focus: false,
      placement: { split: "down", group: { name: "c.ts" } },
    });
    expect(api.getPanel(a.id)!.group).not.toBe(c.group);
    expect(api.activePanel).toBe(c);
  });
});

describe("openBrowserTab", () => {
  test("opens a background tab right after the source tab", () => {
    const { api, a } = setup();
    a.api.setActive();

    openBrowserTab("https://example.com/one", { sourcePanelId: a.id });

    const ids = tabIds(api, 0);
    expect(ids).toHaveLength(3);
    expect(ids[0]).toBe(a.id);
    expect(api.getPanel(ids[1]!)?.params).toEqual({ url: "https://example.com/one" });
    expect(ids[2]).toBe("codeeditor-/repo/b.ts");
    expect(api.groups[0]!.activePanel?.id).toBe(a.id);
  });

  test("keeps tabs opened one after another in order", () => {
    const { api, a } = setup();

    openBrowserTab("https://example.com/one", { sourcePanelId: a.id });
    openBrowserTab("https://example.com/two", { sourcePanelId: a.id });

    const urls = api.groups[0]!.panels.map((p) => (p.params as { url?: string }).url);
    expect(urls).toEqual([
      undefined,
      "https://example.com/one",
      "https://example.com/two",
      undefined,
    ]);
  });

  test("focuses the new tab when asked to", () => {
    const { api, a } = setup();

    openBrowserTab("https://example.com/one", { sourcePanelId: a.id, activate: true });

    expect(api.groups[0]!.activePanel?.params).toEqual({ url: "https://example.com/one" });
  });
});
