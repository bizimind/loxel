import type { ReactNode } from "react";

import type { FileDiff } from "@/api/diff-model";
import { fileDiffPath } from "@/api/diff-model";
import { FileTypeIcon } from "@/lib/file-icons";

/** The sticky row above a file diff: file icon, title and added/deleted line counts. */
export function FileDiffHeader({ file, title }: { file: FileDiff; title?: ReactNode }) {
  const path = fileDiffPath(file);
  return (
    <div className="bg-muted/50 border-border sticky top-0 z-10 flex shrink-0 items-center gap-2 border-b px-3 py-1.5 text-xs">
      <FileTypeIcon filename={path.split("/").pop() ?? ""} className="size-3.5" />
      <span className="text-foreground min-w-0 truncate font-medium">{title ?? path}</span>
      <span className="text-muted-foreground ml-auto flex gap-2 text-[10px]">
        {file.additions > 0 && <span className="text-diff-add-text">+{file.additions}</span>}
        {file.deletions > 0 && <span className="text-diff-del-text">-{file.deletions}</span>}
      </span>
    </div>
  );
}
