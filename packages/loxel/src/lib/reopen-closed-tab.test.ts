import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { DockviewApi, DockviewComponent } from "dockview-react";
import type { AddPanelOptions } from "dockview-react";

// The editors' module-level caches pull in Milkdown and Excalidraw, which these tests don't need.
mock.module("@/components/editor/MarkdownEditor", () => ({
  renameEditorCacheKey: () => {},
  setEditorContent: () => {},
}));
mock.module("@/components/excalidraw-editor/ExcalidrawEditor", () => ({
  renameDrawingCacheKey: () => {},
}));

const { handleFileDeleted, handleFileMoved, openLocalDb, reopenClosedTab } =
  await import("./panel-creators");
const { closeCenterTab, forgetClosedTabGroup, registerClosedTabParams } =
  await import("@/store/closed-tabs");
const { setCenterApi } = await import("@/store/tools-bar");
const { getCurrentWorktreeToolsBar } = await import("@/store/worktree-tools-bar");
const { purgeWorktreeStores } = await import("@/store/worktree-store");
const { useWorktreeStore } = await import("@/store/worktrees");

const WT = "/repo/wt";
const OTHER_WT = "/repo/other";

const CODE = { component: "codeEditor", tabComponent: "codeEditorTab" };

function createCenter(worktreePath = WT): DockviewApi {
  const element = document.createElement("div");
  document.body.append(element);
  const dockview = new DockviewComponent(element, {
    createComponent: () => ({ element: document.createElement("div"), init: () => {} }),
    createTabComponent: () => ({ element: document.createElement("div"), init: () => {} }),
  });
  dockview.layout(800, 600);
  const api = new DockviewApi(dockview);
  setCenterApi(api, worktreePath);
  useWorktreeStore.setState({ activeWorktreePath: worktreePath });
  return api;
}

function addFile(api: DockviewApi, name: string, position?: AddPanelOptions["position"]) {
  return api.addPanel({
    id: `codeeditor-/repo/${name}`,
    ...CODE,
    title: name,
    params: { filePath: `/repo/${name}`, worktreePath: WT },
    position,
  });
}

function ids(api: DockviewApi, groupIndex = 0) {
  return api.groups[groupIndex]!.panels.map((p) => p.title);
}

beforeEach(() => {
  purgeWorktreeStores(WT);
  purgeWorktreeStores(OTHER_WT);
});

afterEach(() => {
  setCenterApi(null);
  document.body.innerHTML = "";
});

describe("reopenClosedTab", () => {
  test("reopens the last closed tab, active, at its old index", () => {
    const api = createCenter();
    const a = addFile(api, "a.ts");
    const b = addFile(api, "b.ts", { referencePanel: a.id, direction: "within" });
    addFile(api, "c.ts", { referencePanel: a.id, direction: "within" });
    a.api.setActive();

    closeCenterTab(b.api);
    expect(ids(api)).toEqual(["a.ts", "c.ts"]);

    reopenClosedTab();

    expect(ids(api)).toEqual(["a.ts", "b.ts", "c.ts"]);
    expect(api.activePanel?.id).toBe(b.id);
    expect(api.activePanel?.params).toEqual({ filePath: "/repo/b.ts", worktreePath: WT });
  });

  test("reopens tabs last closed first, and does nothing with none left", () => {
    const api = createCenter();
    const a = addFile(api, "a.ts");
    const b = addFile(api, "b.ts", { referencePanel: a.id, direction: "within" });

    closeCenterTab(a.api);
    closeCenterTab(b.api);

    reopenClosedTab();
    expect(api.activePanel?.id).toBe(b.id);
    reopenClosedTab();
    expect(api.activePanel?.id).toBe(a.id);
    reopenClosedTab();
    expect(api.panels).toHaveLength(2);
  });

  test("restores the order of a group closed entirely, as one group", () => {
    const api = createCenter();
    const a = addFile(api, "a.ts");
    const b = addFile(api, "b.ts", { referencePanel: a.id, direction: "within" });
    const c = addFile(api, "c.ts", { referencePanel: a.id, direction: "within" });

    for (const panel of [a, b, c]) closeCenterTab(panel.api);
    expect(api.panels).toHaveLength(0);

    reopenClosedTab();
    reopenClosedTab();
    reopenClosedTab();

    expect(api.groups).toHaveLength(1);
    expect(ids(api)).toEqual(["a.ts", "b.ts", "c.ts"]);
  });

  test("opens in the active group when its own group is gone", () => {
    const api = createCenter();
    const a = addFile(api, "a.ts");
    const b = addFile(api, "b.ts", { referencePanel: a.id, direction: "right" });

    closeCenterTab(b.api);
    expect(api.groups).toHaveLength(1);

    reopenClosedTab();

    expect(ids(api)).toEqual(["a.ts", "b.ts"]);
  });

  test("tabs of a removed group keep their order in the group they land in", () => {
    const api = createCenter();
    const x = addFile(api, "x.ts");
    addFile(api, "y.ts", { referencePanel: x.id, direction: "within" });
    const a = addFile(api, "a.ts", { referencePanel: x.id, direction: "right" });
    const b = addFile(api, "b.ts", { referencePanel: a.id, direction: "within" });
    const c = addFile(api, "c.ts", { referencePanel: a.id, direction: "within" });

    for (const panel of [a, b, c]) closeCenterTab(panel.api);
    reopenClosedTab();
    reopenClosedTab();
    reopenClosedTab();

    expect(ids(api)).toEqual(["x.ts", "y.ts", "a.ts", "b.ts", "c.ts"]);
  });

  test("a removed group's id reused by a new group does not attract its closed tabs", () => {
    const api = createCenter();
    const a = addFile(api, "a.ts");
    const b = addFile(api, "b.ts", { referencePanel: a.id, direction: "right" });
    const removedId = b.group.id;

    closeCenterTab(b.api);
    forgetClosedTabGroup(WT, removedId);

    // Ids are reused once a remounted dockview restarts its counter.
    const reused = api.addGroup({ id: removedId, referencePanel: a.id, direction: "right" });
    addFile(api, "c.ts", { referenceGroup: reused.id, direction: "within" });
    a.api.setActive();
    reopenClosedTab();

    expect(api.getPanel(b.id)?.group.id).toBe(a.group.id);
  });

  test("a removed group's tabs still reopen when the first lands below their old index", () => {
    const api = createCenter();
    const p = addFile(api, "p.ts");
    const q = addFile(api, "q.ts", { referencePanel: p.id, direction: "within" });
    const r = addFile(api, "r.ts", { referencePanel: p.id, direction: "within" });
    const s = addFile(api, "s.ts", { referencePanel: p.id, direction: "within" });
    addFile(api, "x.ts", { referencePanel: p.id, direction: "right" });
    const { id: removedId } = p.group;

    closeCenterTab(p.api);
    closeCenterTab(s.api);
    // Removed without being recorded (their files were deleted), which empties the group.
    q.api.close();
    r.api.close();
    forgetClosedTabGroup(WT, removedId);

    reopenClosedTab();
    reopenClosedTab();

    expect(ids(api)).toEqual(["p.ts", "x.ts", "s.ts"]);
  });

  test("brings back the Database tab", () => {
    const api = createCenter();
    const a = addFile(api, "a.ts");
    openLocalDb();
    const db = api.getPanel("localdb-main")!;

    closeCenterTab(a.api);
    closeCenterTab(db.api);
    reopenClosedTab();

    expect(api.getPanel("localdb-main")).toBeDefined();
    expect(api.getPanel(a.id)).toBeUndefined();
  });

  test("skips a tab that is open again", () => {
    const api = createCenter();
    const a = addFile(api, "a.ts");
    const b = addFile(api, "b.ts", { referencePanel: a.id, direction: "within" });

    closeCenterTab(a.api);
    closeCenterTab(b.api);
    addFile(api, "b.ts");

    reopenClosedTab();

    expect(api.activePanel?.id).toBe(a.id);
    expect(api.panels).toHaveLength(2);
  });

  test("keeps stacks per worktree", () => {
    const api = createCenter();
    const a = addFile(api, "a.ts");
    addFile(api, "b.ts", { referencePanel: a.id, direction: "within" });
    closeCenterTab(a.api);

    const other = createCenter(OTHER_WT);
    reopenClosedTab();
    expect(other.panels).toHaveLength(0);

    setCenterApi(api, WT);
    useWorktreeStore.setState({ activeWorktreePath: WT });
    reopenClosedTab();
    expect(api.getPanel(a.id)).toBeDefined();
  });

  test("does nothing while the center belongs to another worktree", () => {
    const api = createCenter();
    const a = addFile(api, "a.ts");
    addFile(api, "b.ts", { referencePanel: a.id, direction: "within" });
    closeCenterTab(a.api);

    useWorktreeStore.setState({ activeWorktreePath: OTHER_WT });
    reopenClosedTab();
    expect(api.getPanel(a.id)).toBeUndefined();

    useWorktreeStore.setState({ activeWorktreePath: WT });
    reopenClosedTab();
    expect(api.getPanel(a.id)).toBeDefined();
  });

  test("brings a browser back on its current page with its renderer", () => {
    const api = createCenter();
    const browser = api.addPanel({
      id: "browser-1",
      component: "browser",
      tabComponent: "browserTab",
      title: "Example",
      params: { url: "https://example.com/first" },
      renderer: "always",
    });
    browser.api.updateParameters({ url: "https://example.com/second", faviconUrl: "/f.ico" });

    closeCenterTab(browser.api);
    reopenClosedTab();

    const reopened = api.getPanel("browser-1")!;
    expect(reopened.params).toEqual({ url: "https://example.com/second", faviconUrl: "/f.ico" });
    expect(reopened.title).toBe("Example");
    expect(reopened.api.renderer).toBe("always");
  });

  test("opens a new terminal session under the same title and working directory", () => {
    const api = createCenter();
    const terminal = api.addPanel({
      id: "terminal-old",
      component: "terminal",
      tabComponent: "terminalTab",
      title: "Terminal",
      params: { terminalId: "old", worktreePath: WT, cwd: "/elsewhere" },
    });
    terminal.api.setTitle("build");

    closeCenterTab(terminal.api);
    reopenClosedTab();

    const reopened = api.panels[0]!;
    expect(reopened.id).not.toBe("terminal-old");
    expect(reopened.title).toBe("build");
    const params = reopened.params as { terminalId: string; cwd: string };
    expect(params.terminalId).not.toBe("old");
    expect(reopened.id).toBe(`terminal-${params.terminalId}`);
    expect(params.cwd).toBe("/elsewhere");
    expect(getCurrentWorktreeToolsBar().getState().terminals).toEqual([
      { id: reopened.id, title: "build", terminalId: params.terminalId },
    ]);
  });

  test("restores live params and drops a past jump and move notice", () => {
    const api = createCenter();
    const a = api.addPanel({
      id: "codeeditor-/repo/a.ts",
      ...CODE,
      params: { filePath: "/repo/a.ts", line: 3, column: 2, movedFrom: "/repo/old.ts" },
    });
    const unregister = registerClosedTabParams(a.id, () => ({ line: 40, column: 7 }));

    closeCenterTab(a.api);
    unregister();
    reopenClosedTab();

    expect(api.getPanel(a.id)?.params).toEqual({ filePath: "/repo/a.ts", line: 40, column: 7 });
  });

  test("a stale past jump is not restored without live params", () => {
    const api = createCenter();
    const a = api.addPanel({
      id: "editor-/repo/a.md",
      component: "editor",
      tabComponent: "markdownEditorTab",
      params: { filePath: "/repo/a.md", line: 3 },
    });

    closeCenterTab(a.api);
    reopenClosedTab();

    expect(api.getPanel(a.id)?.params).toEqual({ filePath: "/repo/a.md" });
  });

  test("tabs removed for other reasons are not recorded", async () => {
    const api = createCenter();
    const a = addFile(api, "a.ts");
    addFile(api, "b.ts", { referencePanel: a.id, direction: "within" });

    handleFileDeleted("/repo/a.ts");
    await handleFileMoved("/repo/b.ts", "/repo/c.ts");
    expect(ids(api)).toEqual(["c.ts"]);

    reopenClosedTab();

    expect(ids(api)).toEqual(["c.ts"]);
  });
});
