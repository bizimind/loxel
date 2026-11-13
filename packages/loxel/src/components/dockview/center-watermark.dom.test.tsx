import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { IWatermarkPanelProps } from "dockview-react";

import type { OpenRequest } from "@/open-request";
import { useBrowserBookmarksStore } from "@/store/browser-bookmarks";
import { useProjectStore } from "@/store/projects";
import { useWorktreeStore } from "@/store/worktrees";

const openRequests: OpenRequest[] = [];
const actualClient = await import("@/api/client");
void mock.module("@/api/client", () => ({
  ...actualClient,
  postOpenRequest: async (request: OpenRequest) => {
    openRequests.push(request);
    return {};
  },
}));

const { onLoxelEvent } = await import("@/lib/loxel-events");
const { WINDOW_ID } = await import("@/lib/window-id");
const { CenterWatermark } = await import("./center-watermark");

const WT = "/repo";
// The page reads none of dockview's watermark props.
const watermarkProps = {} as IWatermarkPanelProps;
const watermark = () => render(<CenterWatermark {...watermarkProps} />);

let browsers: Array<string | undefined>;
let stopListening: () => void;

beforeEach(() => {
  browsers = [];
  openRequests.length = 0;
  stopListening = onLoxelEvent("loxel-create-browser", (detail) => browsers.push(detail?.url));
  useWorktreeStore.setState({ activeWorktreePath: WT });
  useBrowserBookmarksStore.setState({
    bookmarks: [
      { url: "https://github.com/acme/web/pulls", title: "Pull requests" },
      { url: "https://docs.example.com", title: "Acme Docs" },
    ],
  });
});

afterEach(() => {
  cleanup();
  stopListening();
  useWorktreeStore.setState({ activeWorktreePath: null });
  useBrowserBookmarksStore.setState({ bookmarks: [] });
});

/** Each row's label, without its shortcut. */
const rowLabels = () =>
  screen.getAllByRole("button").map((button) => button.querySelector("span")?.textContent);

describe("quickstart page", () => {
  test("lists Terminal, Browser, Plan, Drawing, then Database in a worktree", () => {
    watermark();
    expect(rowLabels()).toEqual([
      "New Terminal",
      "New Browser",
      "New Plan",
      "New Drawing",
      "Database",
    ]);
  });

  test("lists only what needs no worktree in Home, and offers to add a project", () => {
    useWorktreeStore.setState({ activeWorktreePath: null });
    watermark();

    expect(rowLabels()).toEqual(["New Terminal", "New Browser", "New Plan", "Add Project"]);
    let wizardRequests = 0;
    const stop = onLoxelEvent("loxel-open-add-project-wizard", () => wizardRequests++);
    fireEvent.click(screen.getByRole("button", { name: "Add Project" }));
    stop();
    expect(wizardRequests).toBe(1);
  });

  test("makes Add Project the main action before the first project, and only once known", () => {
    useWorktreeStore.setState({ activeWorktreePath: null });
    useProjectStore.setState({ projects: [], projectsFetched: false });
    const { rerender } = watermark();
    const addProject = () => screen.getByRole("button", { name: "Add Project" });
    expect(addProject().className).not.toContain("bg-button-primary");

    useProjectStore.setState({ projectsFetched: true });
    rerender(<CenterWatermark {...watermarkProps} />);
    expect(addProject().className).toContain("bg-button-primary");
    useProjectStore.setState({ projectsFetched: false });
  });

  test("takes no focus of its own", () => {
    watermark();
    expect(document.activeElement).toBe(document.body);
  });

  test("leaves Enter that commits an IME composition alone", () => {
    watermark();
    const field = screen.getByPlaceholderText("Run a command…");
    fireEvent.change(field, { target: { value: "ls" } });
    fireEvent.keyDown(field, { key: "Enter", isComposing: true });
    expect(openRequests).toEqual([]);
  });

  test("runs a command in a new terminal of the worktree, as `loxel terminal` does", () => {
    watermark();
    const field = screen.getByPlaceholderText("Run a command…");

    fireEvent.change(field, { target: { value: "  pnpm run dev " } });
    fireEvent.keyDown(field, { key: "Enter" });

    expect(openRequests).toEqual([
      { terminal: { cwd: WT, command: "pnpm run dev" }, pinWtPath: WT, windowId: WINDOW_ID },
    ]);
    expect((field as HTMLInputElement).value).toBe("");
  });

  test("runs a command from Home in a terminal in the home directory", () => {
    useWorktreeStore.setState({ activeWorktreePath: null });
    useProjectStore.setState({ homeDir: "/Users/me" });
    watermark();
    const field = screen.getByPlaceholderText("Run a command…");

    fireEvent.change(field, { target: { value: "ls" } });
    fireEvent.keyDown(field, { key: "Enter" });

    expect(openRequests).toEqual([
      { terminal: { cwd: "/Users/me", command: "ls" }, windowId: WINDOW_ID },
    ]);
    useProjectStore.setState({ homeDir: null });
  });

  test("opens an address or searches for other text, like the address bar", () => {
    watermark();
    const field = screen.getByPlaceholderText("Open a URL or search…");

    fireEvent.change(field, { target: { value: "example.com" } });
    fireEvent.keyDown(field, { key: "Enter" });
    fireEvent.change(field, { target: { value: "rebase onto" } });
    fireEvent.keyDown(field, { key: "Enter" });

    expect(browsers).toEqual([
      "https://example.com",
      "https://www.google.com/search?q=rebase%20onto",
    ]);
  });

  test("suggests matching bookmarks, picked with the arrow keys or the mouse", () => {
    watermark();
    const field = screen.getByPlaceholderText("Open a URL or search…");
    fireEvent.focus(field);

    fireEvent.change(field, { target: { value: "acme" } });
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual([
      "Pull requestsgithub.com",
      "Acme Docsdocs.example.com",
    ]);

    fireEvent.keyDown(field, { key: "ArrowDown" });
    fireEvent.keyDown(field, { key: "ArrowDown" });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(browsers).toEqual(["https://docs.example.com"]);

    fireEvent.change(field, { target: { value: "pull" } });
    fireEvent.mouseDown(screen.getByRole("option"));
    expect(browsers).toEqual(["https://docs.example.com", "https://github.com/acme/web/pulls"]);
  });
});
