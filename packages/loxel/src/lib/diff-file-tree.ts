import type { FileDiff } from "@/api/diff-model";
import { fileDiffPath } from "@/api/diff-model";
import type { TreeNode } from "@/components/tree";

type BuildNode = Omit<TreeNode, "children"> & { children: BuildNode[] };

/**
 * The Changes panel's tree of `files`: folders first, then by name, with chains of single-folder
 * directories compacted into one node ("src/lib").
 */
export function buildDiffFileTree(files: FileDiff[]): TreeNode[] {
  const root: BuildNode = { name: "", path: "", isDir: true, children: [] };

  for (const file of files) {
    const filePath = fileDiffPath(file);
    const parts = filePath.split("/");
    let current = root;

    for (let i = 0; i < parts.length; i++) {
      const isLast = i === parts.length - 1;
      const name = parts[i];
      if (!name) continue;
      const path = parts.slice(0, i + 1).join("/");

      let child = current.children.find((c) => c.name === name);
      if (!child) {
        child = { name, path, isDir: !isLast, children: [] };
        current.children.push(child);
      }
      current = child;
    }
  }

  function sortTree(nodes: BuildNode[]): BuildNode[] {
    return nodes
      .map((node) => ({ ...node, children: sortTree(node.children) }))
      .sort((a, b) => {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
  }

  return compactTree(sortTree(root.children));
}

function compactTree(nodes: TreeNode[]): TreeNode[] {
  // oxlint-disable-next-line array-callback-return -- all paths return; false positive with while loop
  return nodes.map((node) => {
    if (!node.isDir) return node;
    let name = node.name;
    let current = node;
    let onlyChild = current.children?.[0];
    while (current.children?.length === 1 && onlyChild && onlyChild.isDir) {
      current = onlyChild;
      name = name + "/" + current.name;
      onlyChild = current.children?.[0];
    }
    return {
      ...current,
      name,
      children: current.children ? compactTree(current.children) : undefined,
    };
  });
}

/**
 * `files` in the order the Changes tree lists them. The diff viewer's previous/next file and its
 * "File N of M" counter follow this order, so they walk the tree top to bottom.
 */
export function orderDiffFiles(files: FileDiff[]): FileDiff[] {
  const byPath = new Map(files.map((f) => [fileDiffPath(f), f]));
  const ordered: FileDiff[] = [];
  const visit = (nodes: TreeNode[]) => {
    for (const node of nodes) {
      if (node.isDir) {
        visit(node.children ?? []);
        continue;
      }
      const file = byPath.get(node.path);
      if (file) ordered.push(file);
    }
  };
  visit(buildDiffFileTree(files));
  return ordered;
}
