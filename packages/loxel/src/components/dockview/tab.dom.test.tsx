import { afterEach, describe, expect, jest, test } from "bun:test";

import { act, fireEvent, render, screen } from "@testing-library/react";
import type { DockviewPanelApi } from "dockview-react";

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
