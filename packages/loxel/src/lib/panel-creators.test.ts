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

const { handleFileMoved } = await import("./panel-creators");
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
});

describe("handleFileMoved", () => {
  test("replaces a background tab in place without activating it", () => {
    const { api, a, c } = setup();
    a.api.setActive();
    expect(api.activePanel?.id).toBe("codeeditor-/repo/a.ts");

    handleFileMoved("/repo/b.ts", "/repo/renamed.ts");

    expect(tabIds(api, 0)).toEqual(["codeeditor-/repo/a.ts", "codeeditor-/repo/renamed.ts"]);
    expect(api.activePanel?.id).toBe("codeeditor-/repo/a.ts");
    expect(c.group.activePanel?.id).toBe("codeeditor-/repo/c.ts");
  });

  test("keeps a renamed active tab active", () => {
    const { api, a } = setup();
    a.api.setActive();

    handleFileMoved("/repo/a.ts", "/repo/renamed.ts");

    expect(tabIds(api, 0)).toEqual(["codeeditor-/repo/renamed.ts", "codeeditor-/repo/b.ts"]);
    expect(api.activePanel?.id).toBe("codeeditor-/repo/renamed.ts");
  });

  test("shows the renamed tab in an inactive group without activating that group", () => {
    const { api, b, c } = setup();
    b.api.setActive();
    c.api.setActive();
    expect(api.activeGroup).toBe(c.group);

    handleFileMoved("/repo/b.ts", "/repo/renamed.ts");

    const left = api.groups[0]!;
    expect(left.activePanel?.id).toBe("codeeditor-/repo/renamed.ts");
    expect(api.activeGroup).toBe(c.group);
    expect(api.activePanel?.id).toBe("codeeditor-/repo/c.ts");
  });

  test("keeps a group that held only the renamed tab", () => {
    const { api } = setup();

    handleFileMoved("/repo/c.ts", "/repo/renamed.ts");

    expect(api.groups).toHaveLength(2);
    expect(tabIds(api, 1)).toEqual(["codeeditor-/repo/renamed.ts"]);
  });

  test("drops the old tab when the new path is already open", () => {
    const { api, a } = setup();
    a.api.setActive();

    handleFileMoved("/repo/b.ts", "/repo/c.ts");

    expect(tabIds(api, 0)).toEqual(["codeeditor-/repo/a.ts"]);
    expect(tabIds(api, 1)).toEqual(["codeeditor-/repo/c.ts"]);
    expect(api.activePanel?.id).toBe("codeeditor-/repo/a.ts");
  });

  test("points the old editor entry at the new path so its pending edit is saved there", () => {
    setup();
    useEditorStateStore.getState().openFile("/repo/b.ts");

    expect(handleFileMoved("/repo/b.ts", "/repo/renamed.ts")).toBe(true);

    expect(useEditorStateStore.getState().files.get("/repo/b.ts")?.movedTo).toBe(
      "/repo/renamed.ts",
    );
  });

  test("flushes the old editor's pending edit to the new path before opening it", () => {
    setup();
    const store = useEditorStateStore.getState();
    store.openFile("/repo/b.ts");
    const flushedTo: string[] = [];
    store.registerPendingEditFlush("/repo/b.ts", (target) => {
      flushedTo.push(target);
      // The new tab must not have an editor entry yet when the edit is written.
      expect(useEditorStateStore.getState().files.has("/repo/renamed.ts")).toBe(false);
    });

    handleFileMoved("/repo/b.ts", "/repo/renamed.ts");

    expect(flushedTo).toEqual(["/repo/renamed.ts"]);
  });

  test("closes the old entry when the new path is already open, and reports no replacement", () => {
    setup();
    useEditorStateStore.getState().openFile("/repo/b.ts");

    expect(handleFileMoved("/repo/b.ts", "/repo/c.ts")).toBe(false);

    expect(useEditorStateStore.getState().files.has("/repo/b.ts")).toBe(false);
  });

  test("records the old path on the new tab only when the move is announced", () => {
    const { api } = setup();

    handleFileMoved("/repo/b.ts", "/repo/renamed.ts", { announce: true });
    handleFileMoved("/repo/c.ts", "/repo/quiet.ts");

    expect(api.getPanel("codeeditor-/repo/renamed.ts")?.params?.movedFrom).toBe("/repo/b.ts");
    expect(api.getPanel("codeeditor-/repo/quiet.ts")?.params?.movedFrom).toBeUndefined();
  });

  test("leaves a tab in conflict on its old path, without writing anything", () => {
    const { api } = setup();
    const store = useEditorStateStore.getState();
    store.openFile("/repo/b.ts");
    store.markDirty("/repo/b.ts");
    store.handleDiskChange("/repo/b.ts", [], "theirs");
    expect(useEditorStateStore.getState().files.get("/repo/b.ts")?.state).toBe("diverged");
    const flushedTo: string[] = [];
    store.registerPendingEditFlush("/repo/b.ts", (target) => flushedTo.push(target));

    expect(handleFileMoved("/repo/b.ts", "/repo/renamed.ts")).toBe(false);

    expect(api.getPanel("codeeditor-/repo/b.ts")).toBeDefined();
    expect(api.getPanel("codeeditor-/repo/renamed.ts")).toBeUndefined();
    expect(flushedTo).toEqual([]);
  });

  test("is a no-op for a path with no tab", () => {
    setup();
    expect(handleFileMoved("/repo/none.ts", "/repo/renamed.ts")).toBe(false);
  });
});
