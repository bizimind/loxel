import type { ProjectFileStatus } from "@/api/project-files-model";

export function parentDir(path: string, isDir: boolean): string {
  if (isDir) return path;
  return path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
}

export function fileParentDir(path: string, rootPath: string | null): string {
  if (rootPath && path === rootPath) return rootPath;
  if (!path.includes("/")) return rootPath ?? "";
  const parent = path.slice(0, path.lastIndexOf("/"));
  return parent || rootPath || "";
}

/** Whether `path` is `root` or inside it (a sibling sharing the string prefix is not). */
export function isWithin(path: string, root: string): boolean {
  return path === root || path.startsWith(root + "/");
}

/** The deepest of `roots` that is `path` or contains it; null when none does. */
export function findTreeRoot(path: string, roots: Iterable<string>): string | null {
  let best: string | null = null;
  for (const root of roots) {
    if (!isWithin(path, root)) continue;
    if (!best || root.length > best.length) best = root;
  }
  return best;
}

export function pathName(path: string): string {
  return path.split("/").pop() ?? path;
}

export function statusColorClass(status: ProjectFileStatus | undefined): string | undefined {
  switch (status) {
    case "modified":
      return "text-diff-modify-text";
    case "untracked":
      return "text-diff-add-text";
    case "ignored":
      return "text-muted-foreground";
    case "normal":
    case undefined:
      return undefined;
    default: {
      const _exhaustive: never = status;
      throw new Error(`Unknown ProjectFileStatus: ${String(_exhaustive)}`);
    }
  }
}
