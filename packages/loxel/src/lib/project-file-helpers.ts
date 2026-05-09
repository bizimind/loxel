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
