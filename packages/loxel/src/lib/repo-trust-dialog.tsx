import { getRepoTrust, setRepoTrust } from "@/api/repo-trust-client";
import { requestConfirmation } from "@/components/ui/confirm-dialog-host";
import { showToast } from "@/components/ui/toast";

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
            description: (
              <>
                Trusting <strong>{repository}</strong> lets features that depend on trust run code
                from it, in all its worktrees, which a malicious repository could abuse. Trust it
                only if you would run its code yourself.
                {restrictions.length > 0 && (
                  <>
                    <br />
                    <br />
                    Restricted now: {restrictions.join(" ")}
                  </>
                )}
                <br />
                <br />
                Trust does not let Loxel download or install anything. Dependencies and toolchains
                stay yours to install.
              </>
            ),
            confirmLabel: "Trust Repository",
          },
    );
    if (confirmed) await setRepoTrust({ worktreePath: wtPath, trusted: !trusted });
  } catch (err) {
    showToast(err instanceof Error ? err.message : "Could not change repository trust");
  }
}
