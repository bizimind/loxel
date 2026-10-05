import { describe, expect, jest, spyOn, test } from "bun:test";

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createRef, useState } from "react";

import { FilesTree, type FilesTreeHandle, type TreeNode } from "./FilesTree";
import { TREE_PATH_ATTR } from "./TreeRow";

describe("FilesTree", () => {
  test("renders root children when default-expanded", () => {
    render(
      <FilesTree
        nodes={[
          {
            path: "/repo",
            name: "repo",
            isDir: true,
            children: [{ path: "/repo/a.ts", name: "a.ts", isDir: false }],
          },
        ]}
        defaultExpandedPaths={["/repo"]}
        onOpen={() => {}}
      />,
    );

    expect(screen.getByText("a.ts")).toBeDefined();
  });

  test("renders root children when controlled-expanded", () => {
    render(
      <FilesTree
        nodes={[
          {
            path: "/repo",
            name: "repo",
            isDir: true,
            children: [{ path: "/repo/a.ts", name: "a.ts", isDir: false }],
          },
        ]}
        expandedPaths={new Set(["/repo"])}
        onOpen={() => {}}
      />,
    );

    expect(screen.getByText("a.ts")).toBeDefined();
  });

  test("renders a root header above the root it is returned for", () => {
    const { container } = render(
      <FilesTree
        nodes={[
          { path: "/repo", name: "repo", isDir: true },
          { path: "/notes", name: "notes", isDir: true },
        ]}
        renderRootHeader={(_node, index) => index === 1 && <div>Others</div>}
        onOpen={() => {}}
      />,
    );

    const header = screen.getByText("Others");
    const row = (path: string) => container.querySelector(`button[${TREE_PATH_ATTR}="${path}"]`)!;
    const follows = (a: Element, b: Element) =>
      Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    expect(follows(row("/repo"), header)).toBe(true);
    expect(follows(header, row("/notes"))).toBe(true);
    expect(screen.getAllByText("Others")).toHaveLength(1);
  });

  test("styles focus selection separately from the active opened entry", () => {
    render(
      <FilesTree
        nodes={[
          { path: "/repo/focused.ts", name: "focused.ts", isDir: false },
          { path: "/repo/active.ts", name: "active.ts", isDir: false },
        ]}
        focusedPath="/repo/focused.ts"
        activePath="/repo/active.ts"
        isPanelActive
        onOpen={() => {}}
      />,
    );

    const focused = screen.getByRole("button", { name: /focused\.ts/ });
    const active = screen.getByRole("button", { name: /active\.ts/ });

    expect(focused).toHaveAttribute("data-tree-selected");
    expect(focused).not.toHaveClass("bg-primary");
    expect(focused).toHaveClass("dark:hover:bg-primary/20");
    expect(focused).toHaveClass("dark:focus:bg-primary/50");
    expect(focused).toHaveClass("focus:ring-1");

    expect(active).toHaveAttribute("data-tree-active");
    expect(active).toHaveClass("bg-primary");
  });

  test("loads a lazy single-child directory after auto-expanding it", async () => {
    const loadSubtree = jest.fn(async (path: string): Promise<TreeNode[]> => {
      if (path === "/repo") return [{ path: "/repo/src", name: "src", isDir: true }];
      if (path === "/repo/src") return [{ path: "/repo/src/a.ts", name: "a.ts", isDir: false }];
      return [];
    });

    render(
      <FilesTree
        nodes={[{ path: "/repo", name: "repo", isDir: true }]}
        defaultExpandedPaths={["/repo"]}
        loadSubtree={loadSubtree}
        onOpen={() => {}}
      />,
    );

    await screen.findByText("a.ts");
    expect(loadSubtree).toHaveBeenCalledWith("/repo");
    expect(loadSubtree).toHaveBeenCalledWith("/repo/src");
  });

  test("does not re-expand an explicitly collapsed lazy single-child directory", async () => {
    const treeRef = createRef<FilesTreeHandle>();
    const loadSubtree = jest.fn(async (path: string): Promise<TreeNode[]> => {
      if (path === "/repo") return [{ path: "/repo/src", name: "src", isDir: true }];
      if (path === "/repo/src") {
        return [{ path: "/repo/src/components", name: "components", isDir: true }];
      }
      if (path === "/repo/src/components") {
        return [{ path: "/repo/src/components/Button.tsx", name: "Button.tsx", isDir: false }];
      }
      return [];
    });

    render(
      <FilesTree
        ref={treeRef}
        nodes={[{ path: "/repo", name: "repo", isDir: true }]}
        defaultExpandedPaths={["/repo"]}
        loadSubtree={loadSubtree}
        onOpen={() => {}}
        compactRoot={false}
        onToggle={(path, expanded) => {
          if (!expanded) treeRef.current?.clearSubtree(path);
        }}
      />,
    );

    await screen.findByText("Button.tsx");

    fireEvent.click(screen.getByRole("button", { name: /components/ }));
    await waitFor(() => expect(screen.queryByText("Button.tsx")).toBeNull());

    fireEvent.click(screen.getByRole("button", { name: /repo/ }));
    await waitFor(() => expect(screen.queryByText("src")).toBeNull());

    fireEvent.click(screen.getByRole("button", { name: /repo/ }));

    await screen.findByRole("button", { name: /src/ });
    expect(screen.queryByText("Button.tsx")).toBeNull();
  });

  test("reloadSubtree refreshes rendered root children", async () => {
    const treeRef = createRef<FilesTreeHandle>();
    let children: TreeNode[] = [{ path: "/repo/old.ts", name: "old.ts", isDir: false }];
    const loadSubtree = jest.fn(async () => children);

    render(
      <FilesTree
        ref={treeRef}
        nodes={[{ path: "/repo", name: "repo", isDir: true }]}
        defaultExpandedPaths={["/repo"]}
        loadSubtree={loadSubtree}
        onOpen={() => {}}
      />,
    );

    await screen.findByText("old.ts");
    children = [{ path: "/repo/new.ts", name: "new.ts", isDir: false }];
    treeRef.current?.reloadSubtree("/repo");

    await screen.findByText("new.ts");
    expect(screen.queryByText("old.ts")).toBeNull();
  });

  test("revealPath loads lazy ancestors, focuses the target, and scrolls it into view", async () => {
    const treeRef = createRef<FilesTreeHandle>();
    const scrollIntoViewSpy = spyOn(Element.prototype, "scrollIntoView");
    const focusSpy = spyOn(HTMLElement.prototype, "focus");
    const loadSubtree = jest.fn(async (path: string): Promise<TreeNode[]> => {
      if (path === "/repo") return [{ path: "/repo/src", name: "src", isDir: true }];
      if (path === "/repo/src") {
        return [{ path: "/repo/src/components", name: "components", isDir: true }];
      }
      if (path === "/repo/src/components") {
        return [{ path: "/repo/src/components/Button.tsx", name: "Button.tsx", isDir: false }];
      }
      return [];
    });

    render(
      <FilesTree
        ref={treeRef}
        nodes={[{ path: "/repo", name: "repo", isDir: true }]}
        loadSubtree={loadSubtree}
        onOpen={() => {}}
      />,
    );

    expect(screen.queryByText("Button.tsx")).toBeNull();

    await treeRef.current?.revealPath("/repo/src/components/Button.tsx");

    const target = await screen.findByRole("button", { name: /Button\.tsx/ });
    expect(loadSubtree).toHaveBeenCalledWith("/repo");
    expect(loadSubtree).toHaveBeenCalledWith("/repo/src");
    expect(loadSubtree).toHaveBeenCalledWith("/repo/src/components");
    expect(focusSpy).toHaveBeenCalledWith({ preventScroll: true });
    expect(focusSpy.mock.contexts).toContain(target);
    expect(scrollIntoViewSpy).toHaveBeenCalledWith({ block: "center", behavior: "smooth" });
  });

  test("compacted rows use the leaf path for focus, keyboard, and row callbacks", async () => {
    const onSelect = jest.fn();
    const onToggle = jest.fn();

    function ControlledTree() {
      const [expandedPaths, setExpandedPaths] = useState<Set<string>>(
        () => new Set(["/repo/src", "/repo/src/components"]),
      );
      return (
        <FilesTree
          nodes={[
            {
              path: "/repo/src",
              name: "src",
              isDir: true,
              children: [
                {
                  path: "/repo/src/components",
                  name: "components",
                  isDir: true,
                  children: [
                    { path: "/repo/src/components/Button.tsx", name: "Button.tsx", isDir: false },
                  ],
                },
              ],
            },
          ]}
          expandedPaths={expandedPaths}
          onExpandedPathsChange={setExpandedPaths}
          onOpen={() => {}}
          onSelect={onSelect}
          onToggle={onToggle}
          getRowProps={(node) => ({ title: node.path })}
          renderTrailing={(node) => <span data-testid="trailing">{node.path}</span>}
        />
      );
    }

    const { container } = render(<ControlledTree />);
    const row = screen
      .getAllByRole("button", { name: /src.*components/ })
      .find((button) => button.getAttribute(TREE_PATH_ATTR) === "/repo/src/components");

    expect(row).toBeDefined();
    expect(row!).toHaveAttribute("title", "/repo/src/components");
    expect(row!).toHaveAttribute(TREE_PATH_ATTR, "/repo/src/components");
    expect(screen.getAllByTestId("trailing")[0]).toHaveTextContent("/repo/src/components");

    row!.focus();
    expect(onSelect).toHaveBeenLastCalledWith("/repo/src/components");

    fireEvent.keyDown(container.firstElementChild!, { key: " " });
    await waitFor(() => expect(onToggle).toHaveBeenLastCalledWith("/repo/src/components", false));
  });

  test("keeps the focused row when a root that sorts first is added", () => {
    const b: TreeNode = { path: "/b.ts", name: "b.ts", isDir: false };
    const { container, rerender } = render(<FilesTree nodes={[b]} onOpen={() => {}} />);
    const row = container.querySelector<HTMLButtonElement>(`button[${TREE_PATH_ATTR}="/b.ts"]`)!;
    row.focus();

    rerender(
      <FilesTree nodes={[{ path: "/a.ts", name: "a.ts", isDir: false }, b]} onOpen={() => {}} />,
    );
    expect(document.activeElement).toBe(row);
  });

  test("focuses a row when it is clicked", () => {
    const onSelect = jest.fn();
    render(
      <FilesTree
        nodes={[
          { path: "/repo/dir", name: "dir", isDir: true, children: [] },
          { path: "/repo/a.ts", name: "a.ts", isDir: false },
        ]}
        onOpen={() => {}}
        onSelect={onSelect}
      />,
    );

    const file = screen.getByRole("button", { name: /a\.ts/ });
    fireEvent.click(file);
    expect(document.activeElement).toBe(file);
    expect(onSelect).toHaveBeenLastCalledWith("/repo/a.ts");

    const dir = screen.getByRole("button", { name: /dir/ });
    fireEvent.click(dir);
    expect(document.activeElement).toBe(dir);
    expect(onSelect).toHaveBeenLastCalledWith("/repo/dir");
  });

  describe("keyboard", () => {
    const nodes: TreeNode[] = [
      {
        path: "/repo",
        name: "repo",
        isDir: true,
        children: [
          {
            path: "/repo/src",
            name: "src",
            isDir: true,
            children: [
              { path: "/repo/src/app.ts", name: "app.ts", isDir: false },
              { path: "/repo/src/main.ts", name: "main.ts", isDir: false },
            ],
          },
          { path: "/repo/alpha.md", name: "alpha.md", isDir: false },
          { path: "/repo/beta.md", name: "beta.md", isDir: false },
          { path: "/repo/build.ts", name: "build.ts", isDir: false },
        ],
      },
    ];

    function renderTree() {
      const { container } = render(
        <FilesTree
          nodes={nodes}
          defaultExpandedPaths={["/repo", "/repo/src"]}
          compactRoot={false}
          onOpen={() => {}}
        />,
      );
      const row = (path: string) =>
        container.querySelector<HTMLButtonElement>(`button[${TREE_PATH_ATTR}="${path}"]`)!;
      const focusedPath = () => document.activeElement?.getAttribute(TREE_PATH_ATTR);
      return { row, focusedPath };
    }

    test("Cmd+ArrowUp / Cmd+ArrowDown focus the first / last entry of the focused row's folder", () => {
      const { row, focusedPath } = renderTree();

      row("/repo/alpha.md").focus();
      fireEvent.keyDown(document.activeElement!, { key: "ArrowDown", metaKey: true });
      expect(focusedPath()).toBe("/repo/build.ts");
      // The expanded src folder's children are skipped: src is the folder's first entry.
      fireEvent.keyDown(document.activeElement!, { key: "ArrowUp", metaKey: true });
      expect(focusedPath()).toBe("/repo/src");

      row("/repo/src/main.ts").focus();
      fireEvent.keyDown(document.activeElement!, { key: "ArrowUp", metaKey: true });
      expect(focusedPath()).toBe("/repo/src/app.ts");
      fireEvent.keyDown(document.activeElement!, { key: "ArrowDown", metaKey: true });
      expect(focusedPath()).toBe("/repo/src/main.ts");
    });

    test("typing a letter focuses the next visible entry starting with it, wrapping around", () => {
      const { row, focusedPath } = renderTree();
      const now = spyOn(Date, "now");
      let time = 0;
      now.mockImplementation(() => (time += 1000));

      row("/repo").focus();
      fireEvent.keyDown(document.activeElement!, { key: "b" });
      expect(focusedPath()).toBe("/repo/beta.md");
      fireEvent.keyDown(document.activeElement!, { key: "B" });
      expect(focusedPath()).toBe("/repo/build.ts");
      fireEvent.keyDown(document.activeElement!, { key: "b" });
      expect(focusedPath()).toBe("/repo/beta.md");
      fireEvent.keyDown(document.activeElement!, { key: "a" });
      expect(focusedPath()).toBe("/repo/src/app.ts");
      fireEvent.keyDown(document.activeElement!, { key: "a" });
      expect(focusedPath()).toBe("/repo/alpha.md");
      // No match leaves focus where it is.
      fireEvent.keyDown(document.activeElement!, { key: "z" });
      expect(focusedPath()).toBe("/repo/alpha.md");

      now.mockRestore();
    });

    test("letters typed quickly build up a prefix", () => {
      const { row, focusedPath } = renderTree();
      const now = spyOn(Date, "now");
      let time = 0;
      now.mockImplementation(() => (time += 100));

      row("/repo").focus();
      fireEvent.keyDown(document.activeElement!, { key: "b" });
      expect(focusedPath()).toBe("/repo/beta.md");
      fireEvent.keyDown(document.activeElement!, { key: "u" });
      expect(focusedPath()).toBe("/repo/build.ts");
      // A repeated letter no name starts with steps through the names starting with it.
      row("/repo").focus();
      time += 1000;
      fireEvent.keyDown(document.activeElement!, { key: "a" });
      fireEvent.keyDown(document.activeElement!, { key: "a" });
      expect(focusedPath()).toBe("/repo/alpha.md");

      now.mockRestore();
    });

    test("Space continues a query in progress, and other navigation ends it", () => {
      const { container } = render(
        <FilesTree
          nodes={[
            { path: "/d/Note 1.md", name: "Note 1.md", isDir: false },
            { path: "/d/Note 2.md", name: "Note 2.md", isDir: false },
            { path: "/d/zeta.md", name: "zeta.md", isDir: false },
          ]}
          onOpen={() => {}}
        />,
      );
      const row = (path: string) =>
        container.querySelector<HTMLButtonElement>(`button[${TREE_PATH_ATTR}="${path}"]`)!;
      const focusedPath = () => document.activeElement?.getAttribute(TREE_PATH_ATTR);
      const now = spyOn(Date, "now");
      let time = 0;
      now.mockImplementation(() => (time += 100));

      row("/d/zeta.md").focus();
      for (const key of ["n", "o", "t", "e", " ", "2"]) {
        fireEvent.keyDown(document.activeElement!, { key });
      }
      expect(focusedPath()).toBe("/d/Note 2.md");

      // Within the reset delay, but after an arrow key: "z" starts a new query.
      fireEvent.keyDown(document.activeElement!, { key: "ArrowUp" });
      fireEvent.keyDown(document.activeElement!, { key: "z" });
      expect(focusedPath()).toBe("/d/zeta.md");

      now.mockRestore();
    });

    test("Cmd+ArrowUp / Cmd+ArrowDown stay within a section and step over compacted rows", () => {
      const { container } = render(
        <FilesTree
          nodes={[
            {
              path: "/repo",
              name: "repo",
              isDir: true,
              children: [
                {
                  path: "/repo/src",
                  name: "src",
                  isDir: true,
                  children: [
                    {
                      path: "/repo/src/lib",
                      name: "lib",
                      isDir: true,
                      children: [
                        { path: "/repo/src/lib/a.ts", name: "a.ts", isDir: false },
                        { path: "/repo/src/lib/b.ts", name: "b.ts", isDir: false },
                      ],
                    },
                  ],
                },
                { path: "/repo/z.md", name: "z.md", isDir: false },
              ],
            },
            { path: "/notes", name: "notes", isDir: true },
            { path: "/todo.md", name: "todo.md", isDir: false },
          ]}
          defaultExpandedPaths={["/repo", "/repo/src", "/repo/src/lib"]}
          compactRoot={false}
          renderRootHeader={(_node, index) => index === 1 && <div>Others</div>}
          onOpen={() => {}}
        />,
      );
      const row = (path: string) =>
        container.querySelector<HTMLButtonElement>(`button[${TREE_PATH_ATTR}="${path}"]`)!;
      const focusedPath = () => document.activeElement?.getAttribute(TREE_PATH_ATTR);
      const press = (key: string) =>
        fireEvent.keyDown(document.activeElement!, { key, metaKey: true });

      // "src / lib" is one row; its children render two levels deeper.
      row("/repo/src/lib/b.ts").focus();
      press("ArrowUp");
      expect(focusedPath()).toBe("/repo/src/lib/a.ts");
      press("ArrowUp");
      expect(focusedPath()).toBe("/repo/src/lib/a.ts");

      row("/repo/z.md").focus();
      press("ArrowUp");
      expect(focusedPath()).toBe("/repo/src/lib");

      // Roots: the worktree root is alone in its section, the Others roots share theirs.
      row("/repo").focus();
      press("ArrowDown");
      expect(focusedPath()).toBe("/repo");
      row("/notes").focus();
      press("ArrowDown");
      expect(focusedPath()).toBe("/todo.md");
      press("ArrowUp");
      expect(focusedPath()).toBe("/notes");
    });
  });
});
