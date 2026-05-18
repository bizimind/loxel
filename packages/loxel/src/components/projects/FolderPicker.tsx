import { ChevronRightIcon, FolderIcon, FolderOpenIcon, GitBranchIcon, XIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";

import * as api from "@/api/client";
import type { BrowseEntry } from "@/api/project-model";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface FolderPickerContentProps {
  onSelect: (path: string) => void;
  /** If true, any folder can be selected (not just git repos). */
  allowNonGitFolders?: boolean;
}

export function FolderPickerContent({ onSelect, allowNonGitFolders }: FolderPickerContentProps) {
  const [currentPath, setCurrentPath] = useState("");
  const [dirs, setDirs] = useState<BrowseEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadDir = useCallback(async (path?: string) => {
    setLoading(true);
    setError(null);
    try {
      const result = await api.browse(path);
      setCurrentPath(result.path);
      setDirs(result.dirs);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to browse");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadDir();
  }, [loadDir]);

  const navigateTo = useCallback(
    (path: string) => {
      loadDir(path);
    },
    [loadDir],
  );

  const navigateUp = useCallback(() => {
    const parent = currentPath.replace(/\/[^/]+$/, "") || "/";
    loadDir(parent);
  }, [currentPath, loadDir]);

  const segments = currentPath.split("/").filter(Boolean);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Breadcrumb path */}
      <div className="border-border flex items-center gap-0.5 overflow-x-auto border-b px-4 py-2">
        <button
          onClick={() => loadDir("/")}
          className="text-muted-foreground hover:text-foreground shrink-0 cursor-pointer text-xs"
        >
          /
        </button>
        {segments.map((segment, i) => {
          const segmentPath = "/" + segments.slice(0, i + 1).join("/");
          const isLast = i === segments.length - 1;
          return (
            <span key={segmentPath} className="flex items-center gap-0.5">
              <ChevronRightIcon className="text-muted-foreground size-3 shrink-0" />
              <button
                onClick={() => !isLast && loadDir(segmentPath)}
                className={cn(
                  "shrink-0 text-xs",
                  isLast
                    ? "text-foreground font-medium"
                    : "text-muted-foreground hover:text-foreground cursor-pointer",
                )}
                disabled={isLast}
              >
                {segment}
              </button>
            </span>
          );
        })}
      </div>

      {/* Directory list */}
      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="text-muted-foreground flex h-full items-center justify-center text-sm">
            Loading...
          </div>
        ) : error ? (
          <div className="text-destructive flex h-full items-center justify-center text-sm">
            {error}
          </div>
        ) : dirs.length === 0 ? (
          <div className="text-muted-foreground flex h-full items-center justify-center text-sm">
            No subdirectories
          </div>
        ) : (
          dirs.map((dir) => {
            const canSelect = dir.isGitRepo || allowNonGitFolders;
            return (
              <div
                key={dir.path}
                className="hover:bg-muted/50 flex cursor-pointer items-center gap-2.5 px-4 py-1.5 transition-colors"
                onClick={() => navigateTo(dir.path)}
                onDoubleClick={() => canSelect && onSelect(dir.path)}
              >
                {dir.isGitRepo ? (
                  <GitBranchIcon className="text-primary size-4 shrink-0" />
                ) : (
                  <FolderIcon className="text-muted-foreground size-4 shrink-0" />
                )}
                <span
                  className={cn(
                    "truncate text-xs",
                    dir.isGitRepo ? "text-foreground font-medium" : "text-foreground",
                  )}
                >
                  {dir.name}
                </span>
                {canSelect && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-primary ml-auto h-6 shrink-0 px-2 text-[10px]"
                    onClick={(e) => {
                      e.stopPropagation();
                      onSelect(dir.path);
                    }}
                  >
                    {dir.isGitRepo ? "Open" : "Select"}
                  </Button>
                )}
              </div>
            );
          })
        )}
      </div>

      {/* Footer */}
      <div className="border-border flex items-center justify-between border-t px-4 py-3">
        <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={navigateUp}>
          <FolderOpenIcon className="mr-1 size-3.5" />
          Up
        </Button>
        <Button
          size="sm"
          className="h-7 text-xs"
          onClick={() => onSelect(currentPath)}
          title="Select current directory"
        >
          Select This Folder
        </Button>
      </div>
    </div>
  );
}

// --- Legacy portal-wrapped variant for backward compatibility ---

interface FolderPickerProps {
  open: boolean;
  onSelect: (path: string) => void;
  onClose: () => void;
}

export function FolderPicker({ open, onSelect, onClose }: FolderPickerProps) {
  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="bg-popover border-border flex h-[480px] w-[520px] flex-col rounded-lg border shadow-2xl">
        <div className="border-border flex items-center justify-between border-b px-4 py-3">
          <h3 className="text-foreground text-sm font-medium">Open Project</h3>
          <button
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground cursor-pointer"
          >
            <XIcon className="size-4" />
          </button>
        </div>
        <FolderPickerContent onSelect={onSelect} />
      </div>
    </div>,
    document.body,
  );
}
