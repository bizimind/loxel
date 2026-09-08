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
    expect(focused).toHaveClass("hover:bg-primary/50");
    expect(focused).toHaveClass("focus-visible:bg-primary/50");

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
});
