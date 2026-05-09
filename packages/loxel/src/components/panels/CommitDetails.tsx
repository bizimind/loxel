import { CalendarIcon, GitCommitIcon, UserIcon } from "lucide-react";
import { useMemo } from "react";

import { Badge } from "@/components/ui/badge";
import { useCommitsQuery } from "@/queries/use-repo-queries";
import { useRepositoryStore } from "@/store/worktree-repository";
import { useWorktreeUI } from "@/store/worktree-ui";

export function CommitDetails() {
  const branchFilterPreset = useWorktreeUI((s) => s.branchFilterPreset);
  const { data: commitsData } = useCommitsQuery(branchFilterPreset);
  const commits = commitsData?.commits ?? [];
  const selectedCommits = useRepositoryStore((s) => s.selectedCommits);

  const selectedCommit = useMemo(() => {
    if (selectedCommits.size !== 1) return null;
    const hash = Array.from(selectedCommits)[0];
    return commits.find((c) => c.hash === hash) ?? null;
  }, [commits, selectedCommits]);

  if (selectedCommits.size === 0) {
    return (
      <div className="flex h-full flex-col">
        <div className="border-border border-b px-3 py-1.5">
          <h2 className="text-foreground text-sm font-medium">Commit Details</h2>
        </div>
        <div className="text-muted-foreground flex flex-1 items-center justify-center p-4 text-xs">
          Select a commit to view details
        </div>
      </div>
    );
  }

  if (selectedCommits.size > 1) {
    return (
      <div className="flex h-full flex-col">
        <div className="border-border border-b px-3 py-1.5">
          <h2 className="text-foreground text-sm font-medium">Multiple Commits Selected</h2>
        </div>
        <div className="text-muted-foreground p-4 text-xs">
          {selectedCommits.size} commits selected
        </div>
      </div>
    );
  }

  if (!selectedCommit) return null;

  const formatDate = (dateStr: string) => {
    const date = new Date(dateStr);
    return date.toLocaleString();
  };

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="border-border border-b px-3 py-1.5">
        <h2 className="text-foreground text-sm font-medium">Commit Details</h2>
      </div>

      <div className="flex-1 scrollbar-thin overflow-y-auto p-3">
        {/* Commit message */}
        <div className="mb-3">
          <h3 className="text-foreground text-sm leading-snug">{selectedCommit.message}</h3>
        </div>

        {/* Refs */}
        {selectedCommit.refs.length > 0 && (
          <div className="mb-3 flex flex-wrap gap-1">
            {selectedCommit.refs.map((ref) => (
              <Badge
                key={ref.name}
                variant={
                  ref.type === "HEAD" ? "default" : ref.type === "remote" ? "outline" : "secondary"
                }
                className="text-[10px]"
              >
                {ref.name}
              </Badge>
            ))}
          </div>
        )}

        {/* Hash */}
        <div className="mb-2 flex items-start gap-2 text-xs">
          <GitCommitIcon className="text-muted-foreground mt-0.5 size-3 shrink-0" />
          <div>
            <div className="text-muted-foreground text-[10px] tracking-wide uppercase">Commit</div>
            <div className="text-foreground font-mono text-[11px]">{selectedCommit.hash}</div>
          </div>
        </div>

        {/* Author */}
        <div className="mb-2 flex items-start gap-2 text-xs">
          <UserIcon className="text-muted-foreground mt-0.5 size-3 shrink-0" />
          <div>
            <div className="text-muted-foreground text-[10px] tracking-wide uppercase">Author</div>
            <div className="text-foreground">
              {selectedCommit.author} &lt;{selectedCommit.authorEmail}&gt;
            </div>
          </div>
        </div>

        {/* Date */}
        <div className="mb-2 flex items-start gap-2 text-xs">
          <CalendarIcon className="text-muted-foreground mt-0.5 size-3 shrink-0" />
          <div>
            <div className="text-muted-foreground text-[10px] tracking-wide uppercase">Date</div>
            <div className="text-foreground">{formatDate(selectedCommit.authorDate)}</div>
          </div>
        </div>

        {/* Parents */}
        {selectedCommit.parents.length > 0 && (
          <div className="flex items-start gap-2 text-xs">
            <GitCommitIcon className="text-muted-foreground mt-0.5 size-3 shrink-0" />
            <div>
              <div className="text-muted-foreground text-[10px] tracking-wide uppercase">
                {selectedCommit.parents.length === 1 ? "Parent" : "Parents"}
              </div>
              <div className="text-foreground flex flex-wrap gap-1 font-mono text-[11px]">
                {selectedCommit.parents.map((p) => (
                  <span key={p}>{p.slice(0, 7)}</span>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
