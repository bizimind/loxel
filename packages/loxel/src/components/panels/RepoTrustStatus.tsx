import { skipToken, useQuery } from "@tanstack/react-query";
import { ShieldAlertIcon, ShieldCheckIcon } from "lucide-react";
import { useEffect } from "react";

import { getRepoTrust } from "@/api/repo-trust-client";
import { showToast } from "@/components/ui/toast";
import { manageRepoTrust } from "@/lib/repo-trust-dialog";
import { queryKeys } from "@/queries/query-keys";
import { useQueryScope } from "@/queries/use-scope";

/** Repositories this window has already told about, so a toast comes once per repository. */
const toldRepositories = new Set<string>();

/**
 * The active worktree's repository trust, shown while something runs restricted for lack of it
 * (the moment the question matters, with a toast the first time) and while it is trusted (the way
 * to revoke). An untrusted repository nothing is waiting on, or one the user declined, shows
 * nothing. Clicking asks.
 */
export function RepoTrustStatus() {
  const { activeProject, activeWorktree } = useQueryScope();
  const { data } = useQuery({
    queryKey: queryKeys.repoTrust(activeProject, activeWorktree),
    queryFn: activeWorktree ? () => getRepoTrust(activeWorktree) : skipToken,
    staleTime: Infinity, // WebSocket bridge invalidates it on repo_trust_changed
  });
  // A repository the user declined stays quiet: they answered, and the palette still asks.
  const restricted = data?.decision === "undecided" && data.restrictions.length > 0;
  const trusted = data?.decision === "trusted";
  const repository = data?.repository;

  useEffect(() => {
    if (!restricted || !repository || toldRepositories.has(repository)) return;
    toldRepositories.add(repository);
    showToast(
      "Some features are restricted until you trust this repository. Click Restricted in the status bar to choose.",
      "info",
    );
  }, [restricted, repository]);

  if (!activeWorktree || !data || (!trusted && !restricted)) return null;

  return (
    <button
      type="button"
      onClick={() => void manageRepoTrust(activeWorktree)}
      title={
        trusted
          ? `${data.repository} is trusted. Click to stop trusting it.`
          : [...data.restrictions, "Click to trust this repository"].join("\n")
      }
      className="hover:text-foreground flex cursor-pointer items-center gap-1 transition-colors"
    >
      {trusted ? (
        <ShieldCheckIcon className="size-3.5" />
      ) : (
        <>
          <ShieldAlertIcon className="text-warning size-3.5" />
          Restricted
        </>
      )}
    </button>
  );
}
