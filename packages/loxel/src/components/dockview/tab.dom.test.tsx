import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { DockviewApi, DockviewPanelApi } from "dockview-react";

import { FOCUS_AREA_ATTR } from "@/lib/focus-targets";
import { registerPanelFocus } from "@/lib/panel-focus";
import { canRenameActiveTab, renameActiveTab } from "@/lib/tab-rename";
import { setCenterApi } from "@/store/tools-bar";

import { Tab, usePanelTitle } from "./tab";

/** The parts of a dockview panel API the tab uses, with a working title. */
function fakePanelApi(initialTitle: string) {
  let title = initialTitle;
  const listeners = new Set<(event: { title: string }) => void>();
  const api = {
    id: "panel-1",
    close: jest.fn(),
    group: { panels: [] },
    get title() {
      return title;
    },
    setTitle: (next: string) => {
      title = next;
      for (const listener of listeners) listener({ title: next });
    },
    onDidTitleChange: (listener: (event: { title: string }) => void) => {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
  };
  return api as unknown as DockviewPanelApi;
}

/** Render a tab inside a draggable `.dv-tab`, like dockview does. */
function renderTab(props: Partial<React.ComponentProps<typeof Tab>> = {}) {
  const api = fakePanelApi("notes.md");
  const result = render(
    <div className="dv-tab" draggable="true">
      <Tab api={api} icon={null} title="notes.md" {...props} />
    </div>,
  );
  const dvTab = result.container.querySelector<HTMLElement>(".dv-tab")!;
  return { ...result, api, dvTab };
}

function openContextMenu() {
  fireEvent.contextMenu(screen.getByText("notes.md"), { clientX: 10, clientY: 10 });
}

const getAnimationsDescriptor = Object.getOwnPropertyDescriptor(Element.prototype, "getAnimations");
afterEach(() => {
  setCenterApi(null);
  if (getAnimationsDescriptor) {
    Object.defineProperty(Element.prototype, "getAnimations", getAnimationsDescriptor);
  } else {
    Reflect.deleteProperty(Element.prototype, "getAnimations");
  }
});

describe("Tab rename", () => {
  test("is unavailable without onRename", async () => {
    renderTab();
    fireEvent.doubleClick(screen.getByText("notes.md"));
    expect(screen.queryByRole("textbox")).toBeNull();

    openContextMenu();
    await screen.findByText("Close");
    expect(screen.queryByText("Rename")).toBeNull();
  });

  test("double-clicking the title edits it inline and submits on Enter", async () => {
    const onRename = jest.fn();
    const { dvTab } = renderTab({ onRename, selectBaseName: true });

    fireEvent.doubleClick(screen.getByText("notes.md"));
    const input = screen.getByRole<HTMLInputElement>("textbox");
    expect(input.value).toBe("notes.md");
    expect([input.selectionStart, input.selectionEnd]).toEqual([0, "notes".length]);
    expect(dvTab.getAttribute("draggable")).toBe("false");

    fireEvent.change(input, { target: { value: "plan.md" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onRename).toHaveBeenCalledWith("plan.md");
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(dvTab.getAttribute("draggable")).toBe("true");
  });

  test("keeps pointer events in the input away from dockview's native tab listeners", () => {
    const { dvTab } = renderTab({ onRename: jest.fn() });
    const reached: string[] = [];
    for (const type of ["pointerdown", "click"]) {
      dvTab.addEventListener(type, () => reached.push(type));
    }

    fireEvent.doubleClick(screen.getByText("notes.md"));
    const input = screen.getByRole("textbox");
    fireEvent.pointerDown(input, { shiftKey: true });
    fireEvent.click(input);
    expect(reached).toEqual([]);

    fireEvent.keyDown(input, { key: "Escape" });
    fireEvent.pointerDown(screen.getByText("notes.md"));
    expect(reached).toEqual(["pointerdown"]);
  });

  test("selects the whole title unless selectBaseName is set", () => {
    renderTab({ onRename: jest.fn() });
    fireEvent.doubleClick(screen.getByText("notes.md"));
    const input = screen.getByRole<HTMLInputElement>("textbox");
    expect([input.selectionStart, input.selectionEnd]).toEqual([0, "notes.md".length]);
  });

  test("Escape cancels without renaming", () => {
    const onRename = jest.fn();
    renderTab({ onRename });

    fireEvent.doubleClick(screen.getByText("notes.md"));
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "plan.md" } });
    fireEvent.keyDown(input, { key: "Escape" });

    expect(onRename).not.toHaveBeenCalled();
    expect(screen.getByText("notes.md")).toBeDefined();
  });

  test("the context menu's Rename item keeps the input focused after the menu closes", async () => {
    // Base UI returns focus to the previously focused element once its exit animation ends.
    Object.defineProperty(Element.prototype, "getAnimations", {
      configurable: true,
      value: () => [{ finished: Bun.sleep(100) }],
    });
    const onRename = jest.fn();
    renderTab({ onRename });

    openContextMenu();
    fireEvent.click(await screen.findByText("Rename"));
    await Bun.sleep(200);

    const input = screen.getByRole("textbox");
    expect(document.activeElement).toBe(input);
    fireEvent.change(input, { target: { value: "plan.md" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onRename).toHaveBeenCalledWith("plan.md");
  });
});

describe("Rename Tab action", () => {
  const focusPanel = jest.fn(() => true);
  let unregisterFocus = () => {};
  beforeEach(() => {
    focusPanel.mockClear();
    unregisterFocus = registerPanelFocus("panel-1", focusPanel);
  });
  afterEach(() => unregisterFocus());

  /**
   * A center dockview whose active panel is `panelId` (by default the rendered tab's, `panel-1`).
   * Returns the active group's element.
   */
  function activateTabPanel(panelId = "panel-1"): HTMLElement {
    const group = {
      activePanel: null as unknown,
      element: document.createElement("div"),
      api: { isMaximized: () => false, setActive() {} },
    };
    const panel = {
      id: panelId,
      group,
      view: { content: { element: document.createElement("div") } },
    };
    group.activePanel = panel;
    setCenterApi({ activePanel: panel, hasMaximizedGroup: () => false } as unknown as DockviewApi);
    return group.element;
  }

  test("edits the active tab's title inline, and Enter returns focus to the panel", async () => {
    const onRename = jest.fn();
    renderTab({ onRename });
    activateTabPanel();

    expect(canRenameActiveTab()).toBe(true);
    act(() => renameActiveTab());
    const input = screen.getByRole("textbox");
    expect(document.activeElement).toBe(input);

    fireEvent.change(input, { target: { value: "plan.md" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onRename).toHaveBeenCalledWith("plan.md");
    await waitFor(() => expect(focusPanel).toHaveBeenCalledTimes(1));
  });

  test("is disabled when the active tab is not renameable", () => {
    renderTab();
    activateTabPanel();
    expect(canRenameActiveTab()).toBe(false);
  });

  test("is disabled while focus is in another center group (e.g. a browser page)", () => {
    renderTab({ onRename: jest.fn() });
    const activeGroup = activateTabPanel();
    const center = document.createElement("div");
    center.setAttribute(FOCUS_AREA_ATTR, "center");
    const otherGroup = document.createElement("button");
    center.append(activeGroup, otherGroup);
    const inActiveGroup = document.createElement("button");
    activeGroup.append(inActiveGroup);
    document.body.append(center);

    try {
      otherGroup.focus();
      expect(canRenameActiveTab()).toBe(false);
      inActiveGroup.focus();
      expect(canRenameActiveTab()).toBe(true);
    } finally {
      center.remove();
    }
  });

  test("renaming a background tab returns focus to the active panel, not the tab's", async () => {
    const focusActivePanel = jest.fn(() => true);
    const unregister = registerPanelFocus("panel-2", focusActivePanel);
    renderTab({ onRename: jest.fn() });
    activateTabPanel("panel-2");

    try {
      openContextMenu();
      fireEvent.click(await screen.findByText("Rename"));
      fireEvent.keyDown(screen.getByRole("textbox"), { key: "Escape" });

      await waitFor(() => expect(focusActivePanel).toHaveBeenCalledTimes(1));
      expect(focusPanel).not.toHaveBeenCalled();
    } finally {
      unregister();
    }
  });

  test("Escape cancels and returns focus to the panel", async () => {
    const onRename = jest.fn();
    renderTab({ onRename });
    activateTabPanel();

    act(() => renameActiveTab());
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Escape" });

    expect(onRename).not.toHaveBeenCalled();
    await waitFor(() => expect(focusPanel).toHaveBeenCalledTimes(1));
  });

  test("leaves focus alone when the rename ends on blur", async () => {
    renderTab({ onRename: jest.fn() });
    activateTabPanel();

    act(() => renameActiveTab());
    await Bun.sleep(10);
    fireEvent.blur(screen.getByRole("textbox"));
    await Bun.sleep(100);

    expect(screen.queryByRole("textbox")).toBeNull();
    expect(focusPanel).not.toHaveBeenCalled();
  });

  test("cancels when the input can't take focus (behind a modal dialog)", async () => {
    const onRename = jest.fn();
    renderTab({ onRename });
    activateTabPanel();
    const focus = jest.spyOn(HTMLInputElement.prototype, "focus").mockImplementation(() => {});

    try {
      act(() => renameActiveTab());
      // A boolean, not the element: printing a failed match (the input and its fiber) blocks the
      // event loop for seconds on a loaded runner, delaying the cancel past waitFor's timeout.
      await waitFor(() => expect(screen.queryByRole("textbox") === null).toBe(true));
    } finally {
      focus.mockRestore();
    }
    expect(onRename).not.toHaveBeenCalled();
  });
});

describe("usePanelTitle", () => {
  function Title({ api }: { api: DockviewPanelApi }) {
    return <span>{usePanelTitle(api)}</span>;
  }

  test("re-renders when the panel title changes", () => {
    const api = fakePanelApi("Terminal");
    render(<Title api={api} />);
    expect(screen.getByText("Terminal")).toBeDefined();

    act(() => api.setTitle("server"));
    expect(screen.getByText("server")).toBeDefined();
  });
});
