import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";

import type { WorktreeEntry } from "@/api/git-models";
import type { EnrichedProject } from "@/api/project-model";
import {
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  useProjectStore,
} from "@/store/projects";
import { useWorktreeStore } from "@/store/worktrees";

mock.module("../projects/AddProjectWizard", () => ({ AddProjectWizard: () => null }));

const { Sidebar } = await import("./Sidebar");

const project: EnrichedProject = {
  id: "regular",
  path: "/repo",
  name: "regular-repo",
  addedAt: "2026-01-01T00:00:00.000Z",
  isBare: false,
  worktreesDir: "/repo/.worktrees",
  worktreeMetadata: false,
  worktrees: [
    {
      path: "/repo/.worktrees/topic",
      branch: "topic",
      commit: "abc",
      isMain: false,
      createdAt: null,
      wtName: "topic",
    },
  ],
};

beforeEach(() => {
  useProjectStore.setState({
    projects: [project],
    sidebarExpanded: true,
    sidebarWidth: SIDEBAR_DEFAULT_WIDTH,
    expandedProjectIds: [project.id],
    autoExpandedProjectIds: [project.id],
  });
  useWorktreeStore.setState({
    activeWorktreePath: project.path,
    byProject: {
      [project.path]: { worktrees: project.worktrees, worktreesDir: project.worktreesDir },
    },
  });
});

afterEach(() => {
  useProjectStore.setState({
    projects: [],
    homeDir: null,
    expandedProjectIds: [],
    autoExpandedProjectIds: [],
  });
  useWorktreeStore.getState().reset();
});

describe("Sidebar regular-repository worktrees", () => {
  test("shows linked worktrees and the create action under a regular repo", () => {
    render(<Sidebar />);

    expect(screen.getByText("regular-repo")).toBeDefined();
    expect(screen.getByText("topic")).toBeDefined();
    expect(screen.getByText("Add worktree")).toBeDefined();
  });

  test("does not offer 'Click to load worktrees' for a regular repo with none", () => {
    useProjectStore.setState({ projects: [{ ...project, worktrees: [] }] });
    useWorktreeStore.setState({
      byProject: { [project.path]: { worktrees: [], worktreesDir: project.worktreesDir } },
    });
    render(<Sidebar />);

    expect(screen.queryByText("Click to load worktrees")).toBeNull();
    expect(screen.getByText("Add worktree")).toBeDefined();
  });

  test("auto-expands a project once and keeps a later collapse across remounts", () => {
    useProjectStore.setState({ expandedProjectIds: [], autoExpandedProjectIds: [] });

    const first = render(<Sidebar />);
    expect(useProjectStore.getState().expandedProjectIds).toEqual([project.id]);
    first.unmount();

    // The user collapses it; the sidebar then remounts (as it does on the first worktree click).
    useProjectStore.getState().toggleProjectExpanded(project.id);
    render(<Sidebar />);

    expect(useProjectStore.getState().expandedProjectIds).toEqual([]);
  });

  test("shows a project path under home as ~/ and keeps the full path in its tooltip", () => {
    const homeProject = { ...project, path: "/home/me/git/app", worktrees: [] };
    useProjectStore.setState({ projects: [homeProject], homeDir: "/home/me" });
    render(<Sidebar />);

    expect(screen.getByText("~/git/app").getAttribute("title")).toBe("/home/me/git/app");
  });

  test("switches from a linked worktree back to the regular repository root", async () => {
    useWorktreeStore.setState({ activeWorktreePath: project.worktrees[0]!.path });
    render(<Sidebar />);

    fireEvent.click(screen.getByText("regular-repo"));

    await waitFor(() => {
      expect(useWorktreeStore.getState().activeWorktreePath).toBe(project.path);
    });
  });
});

describe("Sidebar worktree context menu", () => {
  // A branch distinct from the wt name, so the copy tests can tell them apart.
  const worktree = { ...project.worktrees[0]!, branch: "feature/topic" };
  const writeText = mock((_text: string) => Promise.resolve());
  const originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");

  beforeEach(() => {
    writeText.mockClear();
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    setWorktrees([worktree]);
  });

  afterEach(() => {
    if (originalClipboard) Object.defineProperty(navigator, "clipboard", originalClipboard);
    else Reflect.deleteProperty(navigator, "clipboard");
  });

  function setWorktrees(worktrees: WorktreeEntry[]) {
    useWorktreeStore.setState({
      byProject: { [project.path]: { worktrees, worktreesDir: project.worktreesDir } },
    });
  }

  function openMenu() {
    render(<Sidebar />);
    fireEvent.contextMenu(screen.getByText("topic"));
  }

  test.each([
    ["Copy worktree name", "topic"],
    ["Copy branch name", "feature/topic"],
    ["Copy absolute path", worktree.path],
  ])("%s copies %s", async (label, expected) => {
    openMenu();
    fireEvent.click(await screen.findByRole("menuitem", { name: label }));

    expect(writeText).toHaveBeenCalledWith(expected);
  });

  test("copy branch name is disabled for a detached worktree", async () => {
    setWorktrees([{ ...worktree, branch: null }]);
    openMenu();

    const item = await screen.findByRole("menuitem", { name: "Copy branch name" });
    expect(item).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(item);
    expect(writeText).not.toHaveBeenCalled();
  });

  test("archive moves the worktree into the Archive group, and unarchive brings it back", async () => {
    openMenu();
    fireEvent.click(await screen.findByRole("menuitem", { name: "Archive worktree" }));
    expect(useWorktreeStore.getState().byProject[project.path]?.archivedPaths).toEqual([
      worktree.path,
    ]);
    // The Archive starts closed, so the worktree is out of sight until it is opened.
    await waitFor(() => expect(screen.queryByText("topic")).toBeNull());
    fireEvent.click(screen.getByTitle("Open the archive"));

    fireEvent.contextMenu(await screen.findByText("topic"));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Unarchive worktree" }));
    expect(useWorktreeStore.getState().byProject[project.path]?.archivedPaths).toEqual([]);
  });

  test("archiving from the collapsed rail moves the worktree icon into the Archive", async () => {
    useProjectStore.setState({ sidebarExpanded: false });
    const { container } = render(<Sidebar />);
    const entry = (path: string) => container.querySelector(`[data-sidebar-entry="${path}"]`);
    expect(entry(worktree.path)).not.toBeNull();

    fireEvent.contextMenu(entry(worktree.path)!);
    fireEvent.click(await screen.findByRole("menuitem", { name: "Archive worktree" }));

    await waitFor(() => expect(entry(worktree.path)).toBeNull());
    expect(entry(`archive:${project.path}`)).not.toBeNull();
  });
});

describe("Sidebar worktree nesting", () => {
  const parent: WorktreeEntry = {
    ...project.worktrees[0]!,
    path: "/repo/.worktrees/parent",
    wtName: "parent",
    wtId: "id-parent",
    createdAt: "2026-01-01T00:00:00.000Z",
  };
  const child: WorktreeEntry = {
    ...project.worktrees[0]!,
    path: "/repo/.worktrees/child",
    wtName: "child",
    wtId: "id-child",
    parentWtId: "id-parent",
    title: "Child task",
    createdAt: "2026-01-02T00:00:00.000Z",
  };

  // Tests stub these actions; reset() restores state, not actions.
  const { createWorktree, setWorktreeTitle, setWorktreeParent } = useWorktreeStore.getState();
  afterEach(() =>
    useWorktreeStore.setState({ createWorktree, setWorktreeTitle, setWorktreeParent }),
  );

  function setNesting(worktreeMetadata: boolean, worktrees = [parent, child]) {
    useWorktreeStore.setState({
      byProject: {
        [project.path]: { worktrees, worktreesDir: project.worktreesDir, worktreeMetadata },
      },
    });
  }

  async function menuItems(rowText: string): Promise<string[]> {
    fireEvent.contextMenu(screen.getByText(rowText));
    const items = await screen.findAllByRole("menuitem");
    return items.map((item) => item.textContent ?? "");
  }

  test("shows a child under its parent with its title, and folds it away", () => {
    setNesting(true);
    render(<Sidebar />);

    expect(screen.getByText("Child task")).toBeDefined();
    expect(screen.queryByText("child")).toBeNull();
    fireEvent.click(screen.getByTitle("Collapse nested worktrees"));

    expect(screen.queryByText("Child task")).toBeNull();
    expect(useWorktreeStore.getState().byProject[project.path]?.collapsedPaths).toEqual([
      parent.path,
    ]);
  });

  test("shows a child whose parent is gone at the top level", () => {
    setNesting(true, [child]);
    render(<Sidebar />);

    expect(screen.getByText("Child task")).toBeDefined();
    expect(screen.queryByTitle("Collapse nested worktrees")).toBeNull();
  });

  test("the collapsed rail shows nested worktrees in their group, folded by its tab", () => {
    setNesting(true);
    useProjectStore.setState({ sidebarExpanded: false });
    const { container } = render(<Sidebar />);
    const entries = () =>
      [...container.querySelectorAll("[data-sidebar-entry]")].map((e) =>
        e.getAttribute("data-sidebar-entry"),
      );

    expect(entries()).toEqual([project.path, parent.path, child.path]);
    fireEvent.click(screen.getByTitle("Collapse nested worktrees"));
    expect(entries()).toEqual([project.path, parent.path]);
    expect(screen.getByTitle("Expand nested worktrees").textContent).toBe("1");
  });

  test("the collapsed rail folds nesting below its third level into the count", () => {
    const level = (name: string, parentId?: string): WorktreeEntry => ({
      ...project.worktrees[0]!,
      path: `/repo/.worktrees/${name}`,
      wtName: name,
      wtId: `id-${name}`,
      ...(parentId ? { parentWtId: parentId } : {}),
    });
    setNesting(true, [
      level("one"),
      level("two", "id-one"),
      level("three", "id-two"),
      level("four", "id-three"),
    ]);
    useProjectStore.setState({ sidebarExpanded: false });
    const { container } = render(<Sidebar />);

    expect(container.querySelector('[data-sidebar-entry="/repo/.worktrees/three"]')).not.toBeNull();
    expect(container.querySelector('[data-sidebar-entry="/repo/.worktrees/four"]')).toBeNull();

    act(() => useProjectStore.setState({ sidebarExpanded: true }));
    expect(container.querySelector('[data-sidebar-entry="/repo/.worktrees/four"]')).not.toBeNull();
  });

  test("arrow keys fold and unfold a group and step between parent and child", () => {
    setNesting(true);
    const { container } = render(<Sidebar />);
    const entry = (path: string) =>
      container.querySelector<HTMLElement>(`[data-sidebar-entry="${path}"]`);

    fireEvent.keyDown(entry(parent.path)!, { key: "ArrowRight" });
    expect(document.activeElement).toBe(entry(child.path));
    fireEvent.keyDown(entry(child.path)!, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(entry(parent.path));

    fireEvent.keyDown(entry(parent.path)!, { key: "ArrowLeft" });
    expect(useWorktreeStore.getState().byProject[project.path]?.collapsedPaths).toEqual([
      parent.path,
    ]);
    fireEvent.keyDown(entry(parent.path)!, { key: "ArrowRight" });
    expect(useWorktreeStore.getState().byProject[project.path]?.collapsedPaths).toEqual([]);
  });

  test("offers to enable nesting while metadata is off", async () => {
    setNesting(false, [parent]);
    render(<Sidebar />);

    const items = await menuItems("parent");
    expect(items).toContain("Enable worktree nesting…");
    expect(items).not.toContain("New child worktree");
  });

  test("offers nesting actions while metadata is on", async () => {
    setNesting(true);
    render(<Sidebar />);

    expect(await menuItems("parent")).toEqual(
      expect.arrayContaining(["New child worktree", "Edit title"]),
    );
    expect(await menuItems("parent")).not.toContain("Move to top level");
    expect(await menuItems("Child task")).toContain("Move to top level");
  });

  test("move to top level clears the parent", async () => {
    const setWorktreeParent = mock(() => Promise.resolve());
    setNesting(true);
    useWorktreeStore.setState({ setWorktreeParent });
    render(<Sidebar />);

    fireEvent.contextMenu(screen.getByText("Child task"));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Move to top level" }));

    expect(setWorktreeParent).toHaveBeenCalledWith(project.path, child.path, null);
  });

  test("new child worktree opens the dialog, whose name follows the title", async () => {
    const createWorktree = mock(() => Promise.resolve());
    setNesting(true);
    useWorktreeStore.setState({ createWorktree });
    render(<Sidebar />);

    fireEvent.contextMenu(screen.getByText("parent"));
    fireEvent.click(await screen.findByRole("menuitem", { name: "New child worktree" }));
    expect(screen.getByText("Nested under")).toBeDefined();
    fireEvent.change(screen.getByPlaceholderText("What this worktree is for"), {
      target: { value: "Sub task: part 2" },
    });
    const name = screen.getByPlaceholderText("worktree-name");
    expect(name).toHaveValue("sub-task-part-2");
    fireEvent.click(screen.getByRole("button", { name: "Create worktree" }));

    await waitFor(() =>
      expect(createWorktree).toHaveBeenCalledWith(project.path, "sub-task-part-2", {
        parentPath: parent.path,
        title: "Sub task: part 2",
      }),
    );
  });

  test("a name typed in directly stops following the title, until it is cleared", async () => {
    setNesting(true);
    render(<Sidebar />);

    fireEvent.click(screen.getByText("Add worktree"));
    const title = screen.getByPlaceholderText("What this worktree is for");
    const name = screen.getByPlaceholderText("worktree-name");
    fireEvent.change(name, { target: { value: "My Name" } });
    expect(name).toHaveValue("my-name");
    fireEvent.change(title, { target: { value: "Something else" } });
    expect(name).toHaveValue("my-name");

    fireEvent.change(name, { target: { value: "" } });
    fireEvent.change(title, { target: { value: "Something else again" } });
    expect(name).toHaveValue("something-else-again");
  });

  test("without metadata, the dialog asks only for a name", () => {
    setNesting(false, [parent]);
    render(<Sidebar />);

    fireEvent.click(screen.getByText("Add worktree"));
    expect(screen.queryByPlaceholderText("What this worktree is for")).toBeNull();
    expect(screen.getByPlaceholderText("worktree-name")).toBeDefined();
  });

  test("edit title writes the title", async () => {
    const setWorktreeTitle = mock(() => Promise.resolve());
    setNesting(true);
    useWorktreeStore.setState({ setWorktreeTitle });
    render(<Sidebar />);

    fireEvent.contextMenu(screen.getByText("parent"));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Edit title" }));
    const input = screen.getByDisplayValue("parent");
    fireEvent.change(input, { target: { value: "Parent work" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() =>
      expect(setWorktreeTitle).toHaveBeenCalledWith(project.path, parent.path, "Parent work"),
    );
  });
});

describe("Sidebar resizing", () => {
  const sidebarElement = (handle: HTMLElement) => handle.parentElement!;

  function drag(handle: HTMLElement, fromX: number, toX: number) {
    fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientX: fromX });
    fireEvent.pointerMove(handle, { pointerId: 1, buttons: 1, clientX: toX });
  }

  test("has no resize handle while collapsed", () => {
    useProjectStore.setState({ sidebarExpanded: false });
    render(<Sidebar />);

    expect(screen.queryByRole("separator", { name: "Resize sidebar" })).toBeNull();
  });

  test("uses the persisted width when expanded", () => {
    useProjectStore.setState({ sidebarWidth: 320 });
    render(<Sidebar />);

    const handle = screen.getByRole("separator", { name: "Resize sidebar" });
    expect(sidebarElement(handle).style.width).toBe("320px");
  });

  test("tracks the pointer while dragging and persists only on release", () => {
    render(<Sidebar />);
    const handle = screen.getByRole("separator", { name: "Resize sidebar" });

    drag(handle, 100, 180);
    expect(sidebarElement(handle).style.width).toBe(`${SIDEBAR_DEFAULT_WIDTH + 80}px`);
    expect(useProjectStore.getState().sidebarWidth).toBe(SIDEBAR_DEFAULT_WIDTH);

    fireEvent.pointerUp(handle, { pointerId: 1, clientX: 180 });
    expect(useProjectStore.getState().sidebarWidth).toBe(SIDEBAR_DEFAULT_WIDTH + 80);
  });

  test("clamps the width to the allowed range", () => {
    render(<Sidebar />);
    const handle = screen.getByRole("separator", { name: "Resize sidebar" });

    drag(handle, 100, 2000);
    expect(sidebarElement(handle).style.width).toBe(`${SIDEBAR_MAX_WIDTH}px`);
    fireEvent.pointerUp(handle, { pointerId: 1, clientX: 2000 });
    expect(useProjectStore.getState().sidebarWidth).toBe(SIDEBAR_MAX_WIDTH);

    drag(handle, 2000, -2000);
    fireEvent.pointerUp(handle, { pointerId: 1, clientX: -2000 });
    expect(useProjectStore.getState().sidebarWidth).toBe(SIDEBAR_MIN_WIDTH);
  });

  test("pointercancel keeps the last tracked width instead of the cancel coordinates", () => {
    render(<Sidebar />);
    const handle = screen.getByRole("separator", { name: "Resize sidebar" });

    drag(handle, 100, 200);
    fireEvent.pointerCancel(handle, { pointerId: 1, clientX: 0 });
    expect(useProjectStore.getState().sidebarWidth).toBe(SIDEBAR_DEFAULT_WIDTH + 100);
  });

  test("a move with no button pressed ends a drag whose release was missed", () => {
    render(<Sidebar />);
    const handle = screen.getByRole("separator", { name: "Resize sidebar" });

    drag(handle, 100, 150);
    fireEvent.pointerMove(handle, { pointerId: 1, buttons: 0, clientX: 400 });
    expect(useProjectStore.getState().sidebarWidth).toBe(SIDEBAR_DEFAULT_WIDTH + 50);

    // Later hovers no longer resize
    fireEvent.pointerMove(handle, { pointerId: 1, buttons: 0, clientX: 500 });
    expect(sidebarElement(handle).style.width).toBe(`${SIDEBAR_DEFAULT_WIDTH + 50}px`);
  });

  test("lost pointer capture ends the drag", () => {
    render(<Sidebar />);
    const handle = screen.getByRole("separator", { name: "Resize sidebar" });

    drag(handle, 100, 160);
    fireEvent.lostPointerCapture(handle, { pointerId: 1 });
    expect(useProjectStore.getState().sidebarWidth).toBe(SIDEBAR_DEFAULT_WIDTH + 60);
  });

  test("collapsing mid-drag commits the width and restores the expand animation", () => {
    render(<Sidebar />);
    const handle = screen.getByRole("separator", { name: "Resize sidebar" });
    const sidebar = sidebarElement(handle);

    drag(handle, 100, 170);
    act(() => useProjectStore.getState().toggleSidebar());
    expect(useProjectStore.getState().sidebarWidth).toBe(SIDEBAR_DEFAULT_WIDTH + 70);

    act(() => useProjectStore.getState().toggleSidebar());
    expect(sidebar.style.width).toBe(`${SIDEBAR_DEFAULT_WIDTH + 70}px`);
    expect(sidebar.className).toContain("transition-[width]");
  });

  test("double-click resets to the default width", () => {
    useProjectStore.setState({ sidebarWidth: 400 });
    render(<Sidebar />);

    fireEvent.doubleClick(screen.getByRole("separator", { name: "Resize sidebar" }));
    expect(useProjectStore.getState().sidebarWidth).toBe(SIDEBAR_DEFAULT_WIDTH);
  });
});
