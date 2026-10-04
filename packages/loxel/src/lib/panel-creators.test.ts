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
});
