import { useQuery } from "@tanstack/react-query";
import { SearchIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { forgetRepoTrust, listRepoTrust } from "@/api/repo-trust-client";
import type { RepoTrustDecision, RepoTrustEntry } from "@/api/repo-trust-model";
import { Button } from "@/components/ui/button";
import { showToast } from "@/components/ui/toast";
import { manageRepoTrust } from "@/lib/repo-trust-dialog";
import { cn } from "@/lib/utils";
import { queryKeys } from "@/queries/query-keys";

const DECISION_LABELS: Record<RepoTrustDecision, string> = {
  trusted: "Trusted",
  declined: "Declined",
  undecided: "Not decided",
};

type Filter = RepoTrustDecision | "all";

const FILTERS: Filter[] = ["all", "trusted", "declined", "undecided"];

function filterLabel(filter: Filter): string {
  return filter === "all" ? "All" : DECISION_LABELS[filter];
}

/** Trust applies only to the folder it was given for, and a project to answer through. */
function canTrust(entry: RepoTrustEntry): boolean {
  return entry.worktreePath !== null && (entry.decision !== "trusted" || entry.stale);
}

function isLiveTrust(entry: RepoTrustEntry): boolean {
  return entry.decision === "trusted" && !entry.stale;
}

/** Forgetting live trust is Stop Trusting, which asks first, unless no project uses the folder. */
function canForget(entry: RepoTrustEntry): boolean {
  return entry.decision !== "undecided" && (!isLiveTrust(entry) || entry.worktreePath === null);
}

function forget(entry: RepoTrustEntry): void {
  forgetRepoTrust(entry.id).catch((err: unknown) => {
    showToast(err instanceof Error ? err.message : "Could not forget the repository's answer");
  });
}

function RepositoryRow({ entry }: { entry: RepoTrustEntry }) {
  const { worktreePath } = entry;
  // The folder's own name leads, since long paths share their start.
  const name = entry.repository.slice(entry.repository.lastIndexOf("/") + 1) || entry.repository;
  return (
    <li
      aria-label={entry.repository}
      className="grid grid-cols-[1fr_auto] items-start gap-3 px-3 py-2"
    >
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-foreground truncate text-xs font-medium">{name}</span>
          <span
            className={cn(
              "shrink-0 rounded px-1 py-0.5 text-[9px] leading-none",
              isLiveTrust(entry)
                ? "bg-foreground/10 text-foreground"
                : "bg-muted text-muted-foreground",
            )}
          >
            {DECISION_LABELS[entry.decision]}
          </span>
        </div>
        <div className="text-muted-foreground truncate text-[10px]" title={entry.repository}>
          {entry.repository}
        </div>
        {entry.stale && (
          <div className="text-warning mt-0.5 text-[10px]">
            No longer applies: the folder was moved, deleted or replaced.
          </div>
        )}
        {entry.worktreePath === null && !entry.stale && (
          <div className="text-muted-foreground mt-0.5 text-[10px]">
            No project uses this folder.
          </div>
        )}
        {entry.restrictions.length > 0 && (
          <ul className="text-muted-foreground mt-0.5 text-[10px]" aria-label="Restricted">
            {entry.restrictions.map((restriction) => (
              <li key={restriction}>{restriction}</li>
            ))}
          </ul>
        )}
      </div>
      <div className="flex items-center gap-1">
        {worktreePath !== null && isLiveTrust(entry) && (
          <Button
            variant="ghost"
            size="xs"
            onClick={() => void manageRepoTrust(worktreePath, { declineOnCancel: false })}
          >
            Stop Trusting
          </Button>
        )}
        {worktreePath !== null && canTrust(entry) && (
          <Button
            variant="outline"
            size="xs"
            onClick={() => void manageRepoTrust(worktreePath, { declineOnCancel: false })}
          >
            Trust
          </Button>
        )}
        {canForget(entry) && (
          <Button
            variant="ghost"
            size="xs"
            title="Clear this answer, so Loxel asks again"
            onClick={() => forget(entry)}
          >
            Forget
          </Button>
        )}
      </div>
    </li>
  );
}

/**
 * Every repository Loxel knows, with the user's answer about trusting it: the projects'
 * repositories and every stored answer. Each change goes through the same server route as the
 * trust dialog, so dependent servers restart and every window updates.
 */
export function RepositoryTrustSettings() {
  const { data, error } = useQuery({ queryKey: queryKeys.repoTrustList(), queryFn: listRepoTrust });
  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState("");
  const repositories = useMemo(() => data?.repositories ?? [], [data]);

  const shown = useMemo(() => {
    const query = search.trim().toLowerCase();
    return repositories.filter(
      (entry) =>
        (filter === "all" || entry.decision === filter) &&
        (!query || entry.repository.toLowerCase().includes(query)),
    );
  }, [repositories, filter, search]);

  const count = (candidate: Filter): number =>
    candidate === "all"
      ? repositories.length
      : repositories.filter((entry) => entry.decision === candidate).length;

  return (
    <div className="space-y-3">
      <div>
        <h4 className="text-foreground text-xs font-medium">Repository Trust</h4>
        <p className="text-muted-foreground mt-1 text-xs">
          Some features run code from a repository only once you trust it. Declined repositories
          stay untrusted without asking again. Forget an answer to be asked again.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div role="group" aria-label="Show" className="flex gap-1">
          {FILTERS.map((candidate) => (
            <Button
              key={candidate}
              variant="ghost"
              size="xs"
              aria-pressed={filter === candidate}
              className={cn(
                filter === candidate ? "bg-muted text-foreground" : "text-muted-foreground",
              )}
              onClick={() => setFilter(candidate)}
            >
              {filterLabel(candidate)} ({count(candidate)})
            </Button>
          ))}
        </div>
        <div className="relative min-w-40 flex-1">
          <SearchIcon className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-3 -translate-y-1/2" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Filter by folder..."
            aria-label="Filter repositories by folder"
            className="border-input bg-background h-7 w-full rounded border pr-2 pl-7 text-xs"
          />
        </div>
      </div>

      <div className="max-h-[320px] overflow-y-auto rounded-md bg-[var(--surface-2)]">
        {error ? (
          <div className="text-destructive px-3 py-2 text-xs">
            Could not list repositories: {error.message}
          </div>
        ) : shown.length === 0 ? (
          <div className="text-muted-foreground px-3 py-2 text-xs">
            {data ? "No repositories to show." : "Loading..."}
          </div>
        ) : (
          <ul aria-label="Repositories" className="divide-border/50 divide-y">
            {shown.map((entry) => (
              <RepositoryRow key={entry.id} entry={entry} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
