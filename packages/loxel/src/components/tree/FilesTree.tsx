import type { HTMLAttributes, ReactNode } from "react";
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import { getTreeActionForEvent, useTreeKeyboardNav } from "@/hooks/useTreeKeyboardNav";

import { TreeNodeRenderer } from "./TreeNodeRenderer";
import { TREE_PATH_ATTR } from "./TreeRow";

export interface TreeNode {
  path: string;
  name: string;
  isDir: boolean;
  children?: TreeNode[];
}

export interface FilesTreeProps {
  nodes: TreeNode[];
  onOpen: (path: string) => void;
  onSelect?: (path: string) => void;
  onToggle?: (path: string, expanded: boolean) => void;
  onContextMenu?: (e: React.MouseEvent, path: string, isDir: boolean) => void;

  focusedPath?: string | null;
  activePath?: string | null;

  loadSubtree?: (path: string) => Promise<TreeNode[]>;
  expandedPaths?: ReadonlySet<string>;
  defaultExpandedPaths?: Iterable<string>;
  onExpandedPathsChange?: (paths: Set<string>) => void;
  onLoadError?: (path: string, error: unknown) => void;

  labelClassName?: (node: TreeNode) => string | undefined;
  renderLabel?: (node: TreeNode, compactedWith?: TreeNode) => ReactNode;
  renderTrailing?: (node: TreeNode) => ReactNode;
  getRowProps?: (node: TreeNode) => HTMLAttributes<HTMLButtonElement>;
  getRowClassName?: (node: TreeNode) => string | undefined;

  /** Auto-expand all directory nodes when `nodes` changes. User collapses are preserved. */
  autoExpandDirs?: boolean;
  /** Compact a root-level directory that has one directory child. Enabled by default. */
  compactRoot?: boolean;
  /** Skip built-in keyboard navigation (caller handles it at a higher level). */
  disableBuiltinKeyNav?: boolean;

  isPanelActive?: boolean;
  className?: string;
}

export interface FilesTreeHandle {
  getSelectedPath: () => string | null;
  togglePath: (path: string) => void;
  expandPath: (path: string) => void;
  revealPath: (path: string) => Promise<void>;
  reloadSubtree: (path: string) => void;
  clearSubtree: (path: string) => void;
  handlePathsRenamed: (oldPrefix: string, newPrefix: string) => void;
  focusPath: (path: string) => void;
  focusTree: () => void;
}

export const FilesTree = forwardRef<FilesTreeHandle, FilesTreeProps>(function FilesTree(
  {
    nodes,
    onOpen,
    onSelect,
    onToggle,
    onContextMenu,
    focusedPath,
    activePath,
    loadSubtree,
    expandedPaths: controlledExpandedPaths,
    defaultExpandedPaths,
    onExpandedPathsChange,
    onLoadError,
    autoExpandDirs,
    compactRoot = true,
    disableBuiltinKeyNav,
    labelClassName,
    renderLabel,
    renderTrailing,
    getRowProps,
    getRowClassName,
    isPanelActive,
    className,
  },
  ref,
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [internalExpandedPaths, setInternalExpandedPaths] = useState<Set<string>>(
    () => new Set(defaultExpandedPaths),
  );
  const [childrenCache, setChildrenCache] = useState<Map<string, TreeNode[]>>(() => new Map());
  const loadingPathsRef = useRef(new Set<string>());
  const pendingLoadsRef = useRef(new Map<string, Promise<TreeNode[] | undefined>>());
  const [loadingSnapshot, setLoadingSnapshot] = useState<Set<string>>(() => new Set());
  const userCollapsedRef = useRef(new Set<string>());
  const expandedPaths = controlledExpandedPaths ?? internalExpandedPaths;
  const expandedPathsRef = useRef<ReadonlySet<string>>(expandedPaths);
  const pendingRevealRef = useRef<{ path: string; resolve: () => void } | null>(null);
  const [pendingRevealPath, setPendingRevealPath] = useState<string | null>(null);
  const [pendingFocusPath, setPendingFocusPath] = useState<string | null>(null);

  useEffect(() => {
    expandedPathsRef.current = expandedPaths;
  }, [expandedPaths]);

  const focusAndScrollPath = useCallback((path: string) => {
    const container = containerRef.current;
    const btn = container?.querySelector<HTMLButtonElement>(
      `button[${TREE_PATH_ATTR}="${CSS.escape(path)}"]`,
    );
    if (!btn) return false;
    btn.focus({ preventScroll: true });
    btn.scrollIntoView({ block: "center", behavior: "smooth" });
    return true;
  }, []);

  const focusPath = useCallback((path: string) => {
    const container = containerRef.current;
    const btn = container?.querySelector<HTMLButtonElement>(
      `button[${TREE_PATH_ATTR}="${CSS.escape(path)}"]`,
    );
    if (!btn) return false;
    btn.focus({ preventScroll: true });
    return true;
  }, []);

  const updateExpandedPaths = useCallback(
    (updater: (prev: ReadonlySet<string>) => ReadonlySet<string>) => {
      if (controlledExpandedPaths) {
        const prev = expandedPathsRef.current;
        const next = updater(prev);
        if (next !== prev) {
          const nextSet = new Set(next);
          expandedPathsRef.current = nextSet;
          onExpandedPathsChange?.(nextSet);
        }
        return;
      }

      setInternalExpandedPaths((prev) => {
        const next = updater(prev);
        if (next === prev) return prev;
        const nextSet = new Set(next);
        onExpandedPathsChange?.(nextSet);
        return nextSet;
      });
    },
    [controlledExpandedPaths, onExpandedPathsChange],
  );

  // --- Lazy loading ---

  const expandPath = useCallback(
    (path: string) => {
      updateExpandedPaths((prev) => {
        if (prev.has(path)) return prev;
        const next = new Set(prev);
        next.add(path);
        return next;
      });
    },
    [updateExpandedPaths],
  );

  const loadAndCache = useCallback(
    async (path: string): Promise<TreeNode[] | undefined> => {
      if (!loadSubtree) return undefined;
      const pending = pendingLoadsRef.current.get(path);
      if (pending) return pending;

      loadingPathsRef.current.add(path);
      setLoadingSnapshot(new Set(loadingPathsRef.current));

      const promise = (async () => {
        try {
          const children = await loadSubtree(path);
          setChildrenCache((prev) => {
            const next = new Map(prev);
            next.set(path, children);
            return next;
          });
          if (
            children.length === 1 &&
            children[0]!.isDir &&
            !userCollapsedRef.current.has(children[0]!.path)
          ) {
            expandPath(children[0]!.path);
          }
          return children;
        } catch (err) {
          onLoadError?.(path, err);
          return undefined;
        } finally {
          pendingLoadsRef.current.delete(path);
          loadingPathsRef.current.delete(path);
          setLoadingSnapshot(new Set(loadingPathsRef.current));
        }
      })();

      pendingLoadsRef.current.set(path, promise);
      return promise;
    },
    [loadSubtree, expandPath, onLoadError],
  );

  // --- Expand / collapse ---

  const toggleExpanded = useCallback(
    (path: string) => {
      const expanding = !expandedPaths.has(path);
      updateExpandedPaths((prev) => {
        const next = new Set(prev);
        if (expanding) {
          next.add(path);
        } else {
          next.delete(path);
        }
        return next;
      });
      if (expanding) {
        userCollapsedRef.current.delete(path);
      } else {
        userCollapsedRef.current.add(path);
      }
      onToggle?.(path, expanding);
    },
    [expandedPaths, updateExpandedPaths, onToggle],
  );

  useEffect(() => {
    if (!autoExpandDirs) return;
    const dirPaths = collectDirPaths(nodes);
    updateExpandedPaths((prev) => {
      const toAdd = dirPaths.filter((p) => !prev.has(p) && !userCollapsedRef.current.has(p));
      if (toAdd.length === 0) return prev;
      const next = new Set(prev);
      for (const p of toAdd) next.add(p);
      return next;
    });
  }, [nodes, autoExpandDirs, updateExpandedPaths]);

  // Trigger lazy load when a dir is expanded but has no cached children.
  // Searches both the nodes prop (pre-loaded trees) and childrenCache (lazy-loaded subtrees)
  // to find whether a path is a known dir that needs loading.
  useEffect(() => {
    if (!loadSubtree) return;
    for (const path of expandedPaths) {
      if (childrenCache.has(path)) continue;
      const node = findNode(nodes, childrenCache, path);
      if (node?.children) continue;
      loadAndCache(path);
    }
  }, [expandedPaths, nodes, childrenCache, loadSubtree, loadAndCache]);

  // --- Keyboard navigation ---

  const handleTreeKeyDown = useTreeKeyboardNav(containerRef, toggleExpanded);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (handleTreeKeyDown(e)) return;

      if (getTreeActionForEvent(e) === "tree.open") {
        e.preventDefault();
        const focused = document.activeElement as HTMLElement;
        if (!focused) return;
        const path = focused.getAttribute(TREE_PATH_ATTR);
        if (path === null) return;
        if (focused.hasAttribute("data-tree-dir")) {
          toggleExpanded(path);
        } else {
          onOpen(path);
        }
      }
    },
    [handleTreeKeyDown, toggleExpanded, onOpen],
  );

  // --- Focus tracking → onSelect ---

  const handleFocusIn = useCallback(
    (e: React.FocusEvent) => {
      const btn = (e.target as HTMLElement).closest<HTMLButtonElement>(`button[${TREE_PATH_ATTR}]`);
      if (!btn) return;
      const path = btn.getAttribute(TREE_PATH_ATTR);
      if (path !== null) onSelect?.(path);
    },
    [onSelect],
  );

  // --- focusedPath prop → DOM focus ---

  useEffect(() => {
    if (focusedPath === null || focusedPath === undefined) return;
    const container = containerRef.current;
    if (!container) return;
    if (!container.contains(document.activeElement)) return;
    const btn = container.querySelector<HTMLButtonElement>(
      `button[${TREE_PATH_ATTR}="${CSS.escape(focusedPath)}"]`,
    );
    if (btn && btn !== document.activeElement) {
      btn.focus({ preventScroll: true });
    }
  }, [focusedPath]);

  // --- revealPath target → DOM focus/scroll after render ---

  useLayoutEffect(() => {
    if (!pendingRevealPath) return;
    const pending = pendingRevealRef.current;
    if (!pending || pending.path !== pendingRevealPath) return;
    if (!focusAndScrollPath(pendingRevealPath)) return;

    pendingRevealRef.current = null;
    setPendingRevealPath(null);
    pending.resolve();
  }, [pendingRevealPath, expandedPaths, childrenCache, focusAndScrollPath]);

  useLayoutEffect(() => {
    if (!pendingFocusPath) return;
    const path = pendingFocusPath;
    setPendingFocusPath(null);
    if (!focusPath(path)) setPendingFocusPath(path);
  }, [pendingFocusPath, focusedPath, childrenCache, focusPath]);

  // --- Cache helpers ---

  const clearSubtreeCache = useCallback((path: string) => {
    setChildrenCache((prev) => {
      let changed = false;
      const next = new Map(prev);
      for (const k of prev.keys()) {
        if (k === path || k.startsWith(path + "/")) {
          next.delete(k);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, []);

  // --- Ref handle ---

  useImperativeHandle(
    ref,
    () => ({
      getSelectedPath: () => {
        const container = containerRef.current;
        if (!container) return null;
        const focused = container.querySelector<HTMLButtonElement>(
          `button[${TREE_PATH_ATTR}]:focus`,
        );
        return focused?.getAttribute(TREE_PATH_ATTR) ?? null;
      },

      togglePath: (path: string) => {
        toggleExpanded(path);
      },

      expandPath: (path: string) => {
        expandPath(path);
      },

      revealPath: async (targetPath: string) => {
        let currentNodes = nodes;
        let foundTarget = false;
        while (true) {
          if (currentNodes.some((n) => n.path === targetPath)) {
            foundTarget = true;
            break;
          }
          const ancestor = currentNodes.find(
            (n) => n.isDir && (targetPath === n.path || targetPath.startsWith(n.path + "/")),
          );
          if (!ancestor) break;
          if (ancestor.path === targetPath) foundTarget = true;
          expandPath(ancestor.path);
          let children = ancestor.children ?? childrenCache.get(ancestor.path);
          if (!children && loadSubtree) {
            children = await loadAndCache(ancestor.path);
          }
          if (!children) break;
          if (ancestor.path === targetPath) break;
          currentNodes = children;
        }

        if (focusAndScrollPath(targetPath)) return;
        if (!foundTarget) return;

        await new Promise<void>((resolve) => {
          pendingRevealRef.current?.resolve();
          pendingRevealRef.current = { path: targetPath, resolve };
          setPendingRevealPath(targetPath);
        });
      },

      reloadSubtree: (path: string) => {
        if (!loadSubtree) return;
        loadingPathsRef.current.delete(path);
        setChildrenCache((prev) => {
          const next = new Map(prev);
          next.delete(path);
          return next;
        });
        loadAndCache(path);
      },

      clearSubtree: clearSubtreeCache,

      handlePathsRenamed: (oldPrefix: string, newPrefix: string) => {
        updateExpandedPaths((prev) => {
          const next = new Set<string>();
          for (const p of prev) {
            if (p === oldPrefix) {
              next.add(newPrefix);
            } else if (p.startsWith(oldPrefix + "/")) {
              next.add(newPrefix + p.slice(oldPrefix.length));
            } else {
              next.add(p);
            }
          }
          return next;
        });
        userCollapsedRef.current = remapPathSet(userCollapsedRef.current, oldPrefix, newPrefix);
        setChildrenCache((prev) => {
          const next = new Map<string, TreeNode[]>();
          const remapPath = (p: string) =>
            p === oldPrefix
              ? newPrefix
              : p.startsWith(oldPrefix + "/")
                ? newPrefix + p.slice(oldPrefix.length)
                : p;
          for (const [k, v] of prev) {
            next.set(
              remapPath(k),
              v.map((child) => {
                const mapped = remapPath(child.path);
                return mapped !== child.path ? { ...child, path: mapped } : child;
              }),
            );
          }
          return next;
        });
      },

      focusPath: (path: string) => {
        setPendingFocusPath(path);
      },

      focusTree: () => {
        const container = containerRef.current;
        if (!container) return;
        const first = container.querySelector<HTMLButtonElement>(`button[${TREE_PATH_ATTR}]`);
        first?.focus();
      },
    }),
    [
      expandPath,
      focusAndScrollPath,
      focusPath,
      toggleExpanded,
      loadAndCache,
      loadSubtree,
      nodes,
      childrenCache,
      clearSubtreeCache,
      updateExpandedPaths,
    ],
  );

  // --- Render ---

  const resolveChildren = useCallback(
    (node: TreeNode): TreeNode[] | undefined => {
      if (node.children) return node.children;
      return childrenCache.get(node.path);
    },
    [childrenCache],
  );

  return (
    <div
      ref={containerRef}
      className={className}
      tabIndex={disableBuiltinKeyNav ? undefined : 0}
      data-panel-active={isPanelActive ? "" : undefined}
      onKeyDown={disableBuiltinKeyNav ? undefined : handleKeyDown}
      onFocusCapture={handleFocusIn}
    >
      {nodes.map((node) => (
        <TreeNodeRenderer
          key={node.path}
          node={node}
          depth={0}
          expandedPaths={expandedPaths}
          loadingPaths={loadingSnapshot}
          isPanelActive={isPanelActive}
          compactRoot={compactRoot}
          resolveChildren={resolveChildren}
          toggleExpanded={toggleExpanded}
          onOpen={onOpen}
          onContextMenu={onContextMenu}
          labelClassName={labelClassName}
          renderLabel={renderLabel}
          renderTrailing={renderTrailing}
          getRowProps={getRowProps}
          getRowClassName={getRowClassName}
          focusedPath={focusedPath}
          activePath={activePath}
        />
      ))}
    </div>
  );
});

// --- Helpers ---

function collectDirPaths(nodes: TreeNode[]): string[] {
  const result: string[] = [];
  for (const node of nodes) {
    if (node.isDir) {
      result.push(node.path);
      if (node.children) result.push(...collectDirPaths(node.children));
    }
  }
  return result;
}

function findNode(
  nodes: TreeNode[],
  childrenCache: ReadonlyMap<string, TreeNode[]>,
  path: string,
): TreeNode | undefined {
  for (const node of nodes) {
    if (node.path === path) return node;
    if (node.children) {
      const found = findNode(node.children, childrenCache, path);
      if (found) return found;
    }
    const cachedChildren = childrenCache.get(node.path);
    if (cachedChildren) {
      const found = findNode(cachedChildren, childrenCache, path);
      if (found) return found;
    }
  }
  return undefined;
}

function remapPathSet(paths: Set<string>, oldPrefix: string, newPrefix: string): Set<string> {
  const next = new Set<string>();
  for (const p of paths) {
    if (p === oldPrefix) {
      next.add(newPrefix);
    } else if (p.startsWith(oldPrefix + "/")) {
      next.add(newPrefix + p.slice(oldPrefix.length));
    } else {
      next.add(p);
    }
  }
  return next;
}
