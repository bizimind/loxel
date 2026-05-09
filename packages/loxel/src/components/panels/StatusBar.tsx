import {
  AlertCircleIcon,
  ArrowDownIcon,
  ArrowUpIcon,
  GitBranchIcon,
  GlobeIcon,
  NotepadTextIcon,
  PenLineIcon,
  SparklesIcon,
  TerminalSquareIcon,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import {
  createAgent,
  createBrowser,
  createDrawing,
  createEditor,
  createTerminal,
} from "@/lib/panel-creators";
import { useStatusQuery } from "@/queries/use-repo-queries";

export function StatusBar() {
  const { data: status, isLoading, error } = useStatusQuery();

  if (error) {
    return (
      <div className="border-border bg-destructive/10 text-destructive flex h-6 items-center gap-2 border-t px-3 text-xs">
        <AlertCircleIcon className="size-3.5" />
        {error.message}
      </div>
    );
  }

  return (
    <div className="border-border bg-card text-muted-foreground flex h-6 items-center gap-3 border-t px-3 text-xs">
      {/* Branch info */}
      {status && (
        <>
          <div className="flex items-center gap-1.5">
            <GitBranchIcon className="size-3.5" />
            <span className="text-foreground font-medium">{status.branch ?? "detached"}</span>
          </div>

          {/* Upstream tracking */}
          {status.upstream && (
            <div className="flex items-center gap-2">
              {status.ahead > 0 && (
                <span className="flex items-center gap-0.5">
                  <ArrowUpIcon className="size-3" />
                  {status.ahead}
                </span>
              )}
              {status.behind > 0 && (
                <span className="flex items-center gap-0.5">
                  <ArrowDownIcon className="size-3" />
                  {status.behind}
                </span>
              )}
              <span className="text-muted-foreground">{status.upstream}</span>
            </div>
          )}

          <div className="flex-1" />

          {/* Working tree status */}
          <div className="flex items-center gap-2">
            {status.staged.length > 0 && (
              <Badge variant="default" className="h-4 px-1.5 text-[10px]">
                {status.staged.length} staged
              </Badge>
            )}
            {status.unstaged.length > 0 && (
              <Badge variant="secondary" className="h-4 px-1.5 text-[10px]">
                {status.unstaged.length} modified
              </Badge>
            )}
            {status.untracked.length > 0 && (
              <Badge variant="outline" className="h-4 px-1.5 text-[10px]">
                {status.untracked.length} untracked
              </Badge>
            )}
            {status.conflicted.length > 0 && (
              <Badge variant="destructive" className="h-4 px-1.5 text-[10px]">
                {status.conflicted.length} conflicts
              </Badge>
            )}
          </div>
        </>
      )}

      {/* Loading indicator */}
      {isLoading && (
        <div className="text-muted-foreground flex items-center gap-1.5">
          <div className="size-3 animate-spin rounded-full border-2 border-current border-t-transparent" />
          Loading...
        </div>
      )}

      {/* New agent button */}
      <button
        onClick={() => createAgent()}
        title="New Agent"
        className="text-muted-foreground hover:text-foreground flex cursor-pointer items-center gap-1 transition-colors"
      >
        <SparklesIcon className="size-3.5" />
      </button>

      {/* New editor button */}
      <button
        onClick={() => createEditor()}
        title="New Editor"
        className="text-muted-foreground hover:text-foreground flex cursor-pointer items-center gap-1 transition-colors"
      >
        <NotepadTextIcon className="size-3.5" />
      </button>

      {/* New drawing button */}
      <button
        onClick={() => createDrawing()}
        title="New Drawing"
        className="text-muted-foreground hover:text-foreground flex cursor-pointer items-center gap-1 transition-colors"
      >
        <PenLineIcon className="size-3.5" />
      </button>

      {/* New browser button */}
      <button
        onClick={() => createBrowser()}
        title="New Browser"
        className="text-muted-foreground hover:text-foreground flex cursor-pointer items-center gap-1 transition-colors"
      >
        <GlobeIcon className="size-3.5" />
      </button>

      {/* New terminal button */}
      <button
        onClick={() => createTerminal()}
        title="New Terminal"
        className="text-muted-foreground hover:text-foreground flex cursor-pointer items-center gap-1 transition-colors"
      >
        <TerminalSquareIcon className="size-3.5" />
      </button>
    </div>
  );
}
