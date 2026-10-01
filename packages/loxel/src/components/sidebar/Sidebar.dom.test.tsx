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
  useProjectStore.setState({ projects: [], expandedProjectIds: [], autoExpandedProjectIds: [] });
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

  test("hide and show toggle the worktree's visibility", async () => {
    openMenu();
    fireEvent.click(await screen.findByRole("menuitem", { name: "Hide worktree" }));
    expect(useWorktreeStore.getState().byProject[project.path]?.hiddenPaths).toEqual([
      worktree.path,
    ]);

    fireEvent.contextMenu(screen.getByText("topic"));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Show worktree" }));
    expect(useWorktreeStore.getState().byProject[project.path]?.hiddenPaths).toEqual([]);
  });

  test("hiding from the collapsed rail removes the worktree icon", async () => {
    useProjectStore.setState({ sidebarExpanded: false });
    const { container } = render(<Sidebar />);
    const icon = () => container.querySelector(`[aria-roledescription="sortable"] button`);
    expect(icon()).not.toBeNull();

    fireEvent.contextMenu(icon()!);
    fireEvent.click(await screen.findByRole("menuitem", { name: "Hide worktree" }));

    await waitFor(() => expect(icon()).toBeNull());
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
