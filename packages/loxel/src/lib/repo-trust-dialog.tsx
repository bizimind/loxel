import type { ReactNode } from "react";

import { runInitHook } from "@/api/client";
import { getRepoTrust, setRepoTrust } from "@/api/repo-trust-client";
import { requestConfirmation } from "@/components/ui/confirm-dialog-host";
import { showToast } from "@/components/ui/toast";

/** What trusting a repository means, said the same way wherever Loxel asks. */
function TrustExplanation({
  repository,
  restrictions,
}: {
  repository: string;
  restrictions: string[];
}): ReactNode {
  return (
    <>
      Trusting <strong>{repository}</strong> lets features that depend on trust run code from it, in
      all its worktrees, which a malicious repository could abuse. Trust it only if you would run
      its code yourself.
      {restrictions.length > 0 && (
        <>
          <br />
          <br />
          Restricted now: {restrictions.join(" ")}
        </>
      )}
      <br />
      <br />
      Trust does not let Loxel download or install anything. Dependencies and toolchains stay yours
      to install.
    </>
  );
}

/**
 * Asks whether to trust the worktree's repository, or to stop trusting it, and applies the answer.
 * The server tells every window, and restarts whatever depends on the answer.
 */
export async function manageRepoTrust(wtPath: string): Promise<void> {
  try {
    const { repository, trusted, restrictions } = await getRepoTrust(wtPath);
    const confirmed = await requestConfirmation(
      trusted
        ? {
            title: "Stop trusting this repository?",
            description: (
              <>
                Features that depend on trust stop running code from <strong>{repository}</strong>,
                in all its worktrees, and restart restricted.
              </>
            ),
            confirmLabel: "Stop Trusting",
            destructive: true,
          }
        : {
            title: "Trust this repository?",
            description: <TrustExplanation repository={repository} restrictions={restrictions} />,
            confirmLabel: "Trust Repository",
          },
    );
    if (confirmed) await setRepoTrust({ worktreePath: wtPath, trusted: !trusted });
  } catch (err) {
    showToast(err instanceof Error ? err.message : "Could not change repository trust");
  }
}

/**
 * Asks to trust the worktree's repository, after `reason` says what is waiting on it. Resolves
 * true when the repository is trusted, already or by this answer.
 */
export async function askToTrustRepo(
  wtPath: string,
  ask: { title: string; reason: ReactNode; confirmLabel: string },
): Promise<boolean> {
  const { repository, trusted, restrictions } = await getRepoTrust(wtPath);
  if (trusted) return true;
  const confirmed = await requestConfirmation({
    title: ask.title,
    description: (
      <>
        {ask.reason}
        <br />
        <br />
        <TrustExplanation repository={repository} restrictions={restrictions} />
      </>
    ),
    confirmLabel: ask.confirmLabel,
    cancelLabel: "Not Now",
  });
  if (confirmed) await setRepoTrust({ worktreePath: wtPath, trusted: true });
  return confirmed;
}

/**
 * Says that a new worktree's `init.wt.sh` did not run because its repository is not trusted, and
 * offers to trust the repository and run it now.
 */
export async function offerToRunInitHook(projectPath: string, wtPath: string): Promise<void> {
  try {
    const trusted = await askToTrustRepo(wtPath, {
      title: "Trust this repository and run init.wt.sh?",
      reason: (
        <>
          The new worktree was created without running the repository&rsquo;s{" "}
          <code>init.wt.sh</code>: hooks run in trusted repositories.
        </>
      ),
      confirmLabel: "Trust and Run",
    });
    if (!trusted) return;
    const { hookRan } = await runInitHook(projectPath, wtPath);
    if (!hookRan) showToast("init.wt.sh did not finish. Any output it gave is in the Logs panel.");
  } catch (err) {
    showToast(err instanceof Error ? err.message : "Could not run init.wt.sh");
  }
}
