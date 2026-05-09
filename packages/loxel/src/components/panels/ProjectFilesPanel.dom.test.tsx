import type { QueryClient } from "@tanstack/react-query";
import type { ReactNode } from "react";

import { QueryClientProvider, QueryClient as ReactQueryClient } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, jest, mock, spyOn, test } from "bun:test";

import type { DirEntry } from "@/api/project-files-model";

const eventListeners = new Map<string, Array<(data: unknown) => void>>();
const dispatchedEvents = new Map<string, unknown[]>();
const stopAutoScroll = jest.fn();
const centerApiState: {
  api: {
    activePanel: { id: string } | null;
    onDidActivePanelChange: (listener: () => void) => { dispose: () => void };
  } | null;
  listeners: Set<
    (
      api: {
        activePanel: { id: string } | null;
        onDidActivePanelChange: (listener: () => void) => { dispose: () => void };
      } | null,
    ) => void
  >;
} = { api: null, listeners: new Set() };

const originalClient = await import("@/api/client");
mock.module("@/api/client", () => ({
  ...originalClient,
  getDirContents: jest.fn(),
  moveDetachedFileToProject: jest.fn(async () => ({ newPath: "/repo/src/Draft.md" })),
  moveProjectFile: jest.fn(async (_wt: string, options: { srcPath: string; destDir: string }) => ({
    newPath: `${options.destDir}/${options.srcPath.split("/").pop()}`,
  })),
  putStore: jest.fn(async () => ({ success: true })),
  unwatchDir: jest.fn(),
}));

mock.module("@/components/menus/ProjectFileMenu", () => ({
  ProjectFileMenu: ({ filePath }: { filePath: string }) => (
    <div data-testid="project-file-menu" data-file-path={filePath} />
  ),
}));

mock.module("@/components/panels/DraggablePanelHeader", () => ({
  DraggablePanelHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

mock.module("@/hooks/useDragAutoScroll", () => ({
  useDragAutoScroll: () => ({ startAutoScroll: jest.fn(), stopAutoScroll }),
}));

mock.module("@/hooks/usePanelActive", () => ({ usePanelActive: () => true }));

mock.module("@/lib/loxel-events", () => ({
  dispatchLoxelEvent: (type: string, data: unknown) => {
    const events = dispatchedEvents.get(type) ?? [];
    events.push(data);
    dispatchedEvents.set(type, events);
  },
  onLoxelEvent: (type: string, cb: (data: unknown) => void) => {
    const listeners = eventListeners.get(type) ?? [];
    listeners.push(cb);
    eventListeners.set(type, listeners);
    return () => {
      eventListeners.set(
        type,
        (eventListeners.get(type) ?? []).filter((listener) => listener !== cb),
      );
    };
  },
}));

mock.module("@/store/tools-bar", () => ({
  getCenterApi: () => centerApiState.api,
  subscribeCenterApi: (
    listener: (
      api: {
        activePanel: { id: string } | null;
        onDidActivePanelChange: (listener: () => void) => { dispose: () => void };
      } | null,
    ) => void,
  ) => {
    centerApiState.listeners.add(listener);
    return () => centerApiState.listeners.delete(listener);
  },
}));

mock.module("@/queries/use-git-mutations", () => ({
  useDiscardChangesMutation: () => ({ mutateAsync: jest.fn() }),
}));

mock.module("@/queries/use-repo-queries", () => ({
  useDetachedFilesQuery: () => ({ data: [] }),
  useExternalFilesQuery: () => ({ data: [] }),
}));

mock.module("@/queries/use-scope", () => ({
  getQueryScope: () => ({ activeProjectPath: "/project", activeWorktreePath: "/repo" }),
}));

const api = await import("@/api/client");
const { buildReverseLookup } = await import("@/store/keybindings/keybinding-resolver");
const { TEMPLATES } = await import("@/store/keybindings/keybinding-schema");
const { useKeybindingStore } = await import("@/store/keybindings/keybinding-store");
const { useSettingsStore } = await import("@/store/settings-store");
const { setActiveWorktreeKey } = await import("@/store/worktree-store");
const { getCurrentWorktreeUI } = await import("@/store/worktree-ui");
const { useWorktreeStore } = await import("@/store/worktrees");
const { ProjectFilesPanel } = await import("./ProjectFilesPanel");

function renderPanel(queryClient: QueryClient) {
  return render(
    <QueryClientProvider client={queryClient}>
      <ProjectFilesPanel />
    </QueryClientProvider>,
  );
}

function emitDirChanged(dir: string) {
  for (const listener of eventListeners.get("loxel-dir-changed") ?? []) {
    listener({ dir });
  }
}

function emitRevealInExplorer(filePath: string) {
  for (const listener of eventListeners.get("loxel-reveal-in-explorer") ?? []) {
    listener({ filePath });
  }
}

function setMockCenterApi(nextApi: typeof centerApiState.api) {
  centerApiState.api = nextApi;
  for (const listener of centerApiState.listeners) {
    listener(nextApi);
  }
}

function createMockCenterApi(initialActivePanelId: string) {
  let activePanelId = initialActivePanelId;
  const panelChangeListeners = new Set<() => void>();
  return {
    get activePanel() {
      return { id: activePanelId };
    },
    setActivePanelId(nextPanelId: string) {
      activePanelId = nextPanelId;
      for (const listener of panelChangeListeners) {
        listener();
      }
    },
    onDidActivePanelChange(listener: () => void) {
      panelChangeListeners.add(listener);
      return { dispose: () => panelChangeListeners.delete(listener) };
    },
  };
}

describe("ProjectFilesPanel", () => {
  let entriesByDir: Map<string, DirEntry[]>;
  let queryClient: QueryClient;

  beforeEach(async () => {
    eventListeners.clear();
    dispatchedEvents.clear();
    stopAutoScroll.mockClear();
    setMockCenterApi(null);
    useSettingsStore.setState({ autoRevealInExplorer: false });
    useKeybindingStore.setState({
      activeTemplate: "loxel",
      overrides: {},
      lookup: buildReverseLookup(TEMPLATES.loxel, {}),
    });
    queryClient = new ReactQueryClient({ defaultOptions: { queries: { retry: false } } });
    entriesByDir = new Map([
      [
        "/repo",
        [
          { name: "src", path: "/repo/src", isDir: true, status: "normal" },
          { name: "README.md", path: "/repo/README.md", isDir: false, status: "normal" },
        ],
      ],
      [
        "/repo/src",
        [{ name: "components", path: "/repo/src/components", isDir: true, status: "normal" }],
      ],
      [
        "/repo/src/components",
        [
          {
            name: "Button.tsx",
            path: "/repo/src/components/Button.tsx",
            isDir: false,
            status: "normal",
          },
        ],
      ],
    ]);

    (api.getDirContents as ReturnType<typeof jest.fn>).mockImplementation(
      async (_wt: string, dir: string) => {
        return entriesByDir.get(dir) ?? [];
      },
    );

    useWorktreeStore.setState({ activeWorktreePath: "/repo" });
    setActiveWorktreeKey("/repo");
    getCurrentWorktreeUI().setState({
      selectedProjectFile: null,
      expandedProjectFolders: new Set(),
    });
  });

  test("shows the worktree root and expands it on mount", async () => {
    renderPanel(queryClient);

    const root = screen.getByRole("button", { name: /repo/ });
    expect(root).toBeInTheDocument();
    await waitFor(() => expect(root).toHaveFocus());
    expect(await screen.findByRole("button", { name: /src/ })).toBeInTheDocument();
  });

  test("allows the worktree root to stay collapsed", async () => {
    renderPanel(queryClient);

    const root = screen.getByRole("button", { name: /repo/ });
    expect(await screen.findByRole("button", { name: /src/ })).toBeInTheDocument();

    fireEvent.click(root);

    await waitFor(() => expect(screen.queryByRole("button", { name: /src/ })).toBeNull());
    expect(root).not.toHaveAttribute("data-tree-expanded");
  });

  test("context menu root actions target the absolute worktree root", async () => {
    renderPanel(queryClient);

    const root = screen.getByRole("button", { name: /repo/ });
    fireEvent.contextMenu(root);

    expect(screen.getByTestId("project-file-menu")).toHaveAttribute("data-file-path", "/repo");
  });

  test("root dir-changed events reload rendered root children", async () => {
    renderPanel(queryClient);
    expect(await screen.findByRole("button", { name: /src/ })).toBeInTheDocument();

    entriesByDir.set("/repo", [{ name: "app", path: "/repo/app", isDir: true, status: "normal" }]);
    queryClient.setQueryData(["dirContents", "/project", "/repo"], entriesByDir.get("/repo"));

    await act(async () => emitDirChanged("/repo"));

    expect(await screen.findByRole("button", { name: /app/ })).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /src/ })).not.toBeInTheDocument(),
    );
  });

  test("reveal-in-explorer loads lazy ancestors, focuses the file, and scrolls it into view", async () => {
    const focus = spyOn(HTMLElement.prototype, "focus");
    const scrollIntoView = spyOn(Element.prototype, "scrollIntoView");
    renderPanel(queryClient);

    expect(await screen.findByRole("button", { name: /src/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Button\.tsx/ })).not.toBeInTheDocument();

    await act(async () => emitRevealInExplorer("/repo/src/components/Button.tsx"));

    const target = await screen.findByRole("button", { name: /Button\.tsx/ });
    await waitFor(() => {
      expect(api.getDirContents).toHaveBeenCalledWith("/repo", "/repo/src");
      expect(api.getDirContents).toHaveBeenCalledWith("/repo", "/repo/src/components");
      expect(getCurrentWorktreeUI().getState().selectedProjectFile).toBe(
        "/repo/src/components/Button.tsx",
      );
      expect(focus.mock.contexts).toContain(target);
      expect(scrollIntoView).toHaveBeenCalledWith({ block: "center", behavior: "smooth" });
    });
  });

  test("Enter opens the focused file and F2 starts rename", async () => {
    renderPanel(queryClient);

    const readme = await screen.findByRole("button", { name: /README\.md/ });
    readme.focus();
    fireEvent.keyDown(readme, { key: "Enter" });

    expect(dispatchedEvents.get("loxel-open-markdown-editor")).toEqual([
      { filePath: "/repo/README.md", line: undefined, column: undefined },
    ]);

    fireEvent.keyDown(readme, { key: "F2" });

    expect(await screen.findByDisplayValue("README.md")).toBeInTheDocument();
  });

  test("canceling inline rename restores focus to the row", async () => {
    renderPanel(queryClient);

    const readme = await screen.findByRole("button", { name: /README\.md/ });
    readme.focus();
    fireEvent.keyDown(readme, { key: "F2" });

    const input = await screen.findByDisplayValue("README.md");
    expect(input).toHaveFocus();

    fireEvent.keyDown(input, { key: "Escape" });

    await waitFor(() => expect(readme).toHaveFocus());
  });

  test("auto-reveal subscribes when the center api becomes available after mount", async () => {
    useSettingsStore.setState({ autoRevealInExplorer: true });
    const focus = spyOn(HTMLElement.prototype, "focus");
    const centerApi = createMockCenterApi("codeeditor-/repo/src/components/Button.tsx");
    renderPanel(queryClient);

    await screen.findByRole("button", { name: /src/ });
    expect(screen.queryByRole("button", { name: /Button\.tsx/ })).not.toBeInTheDocument();

    await act(async () => setMockCenterApi(centerApi));

    const target = await screen.findByRole("button", { name: /Button\.tsx/ });
    await waitFor(() => {
      expect(getCurrentWorktreeUI().getState().selectedProjectFile).toBe(
        "/repo/src/components/Button.tsx",
      );
      expect(focus.mock.contexts).toContain(target);
    });

    await act(async () => centerApi.setActivePanelId("codeeditor-/repo/README.md"));

    const readme = await screen.findByRole("button", { name: /README\.md/ });
    await waitFor(() => {
      expect(getCurrentWorktreeUI().getState().selectedProjectFile).toBe("/repo/README.md");
      expect(focus.mock.contexts).toContain(readme);
    });
  });

  test("row drops stop drag auto-scroll", async () => {
    renderPanel(queryClient);

    const src = await screen.findByRole("button", { name: /src/ });
    fireEvent.drop(src, {
      dataTransfer: {
        getData: (type: string) => (type === "application/x-project-file" ? "/repo/file.ts" : ""),
      },
    });

    expect(stopAutoScroll).toHaveBeenCalled();
  });
});
