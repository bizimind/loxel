import type { ReactNode } from "react";

import { runInitHook } from "@/api/client";
import { getRepoTrust, setRepoTrust } from "@/api/repo-trust-client";
import type { RepoTrustStatus } from "@/api/repo-trust-model";
import type { ConfirmationOptions } from "@/components/ui/confirm-dialog-host";
import { requestAnswer } from "@/components/ui/confirm-dialog-host";
import { showToast } from "@/components/ui/toast";

/** What trusting a repository means, said the same way wherever Loxel asks. */
function TrustExplanation({
  repository,
  restrictions,
}: Pick<RepoTrustStatus, "repository" | "restrictions">): ReactNode {
  return (
    <>
      <p>
        Trusting <strong>{repository}</strong> lets features that depend on trust run code from it,
        in all its worktrees, which a malicious repository could abuse. Trust it only if you would
        run its code yourself.
      </p>
      {restrictions.length > 0 && (
        <>
          <p className="mt-2">Restricted now:</p>
          <ul className="list-disc pl-4">
            {restrictions.map((restriction) => (
              <li key={restriction}>{restriction}</li>
            ))}
          </ul>
        </>
      )}
      <p className="mt-2">
        Trust does not let Loxel download or install anything. Dependencies and toolchains stay
        yours to install.
      </p>
    </>
  );
}

function trustQuestion(status: RepoTrustStatus): ConfirmationOptions {
  return {
    title: "Trust this repository?",
    description: <TrustExplanation {...status} />,
    confirmLabel: "Trust Repository",
  };
}

function stopTrustingQuestion({ repository }: RepoTrustStatus): ConfirmationOptions {
  return {
    title: "Stop trusting this repository?",
    description: (
      <>
        Features that depend on trust stop running code from <strong>{repository}</strong>, in all
        its worktrees, and restart restricted.
      </>
    ),
    confirmLabel: "Stop Trusting",
    destructive: true,
  };
}

/**
 * Record a "no" to the trust question, so the status bar stops asking. A question another one
 * replaced (`answer` null) was not answered, and one already declined needs no new row.
 */
async function recordAnswer(
  wtPath: string,
  status: RepoTrustStatus,
  answer: boolean | null,
): Promise<boolean> {
  if (answer === true) {
    await setRepoTrust({ worktreePath: wtPath, decision: "trusted" });
    return true;
  }
  if (answer === false && status.decision === "undecided") {
    // The server keeps trust given in another window while this question was open.
    await setRepoTrust({ worktreePath: wtPath, decision: "declined", unlessTrusted: true });
  }
  return false;
}

/**
 * Asks whether to trust the worktree's repository, or to stop trusting it, and applies the answer.
 * The server tells every window, and restarts whatever depends on the answer. Stopping trust, or
 * answering "no" to trusting, records the repository as declined, so the status bar goes quiet.
 * Settings, a view for managing every answer, passes `declineOnCancel: false`: backing out of its
 * dialog leaves the answer listed as it was.
 */
export async function manageRepoTrust(
  wtPath: string,
  { declineOnCancel = true }: { declineOnCancel?: boolean } = {},
): Promise<void> {
  try {
    const status = await getRepoTrust(wtPath);
    if (status.decision === "trusted") {
      const answer = await requestAnswer(stopTrustingQuestion(status));
      if (answer) await setRepoTrust({ worktreePath: wtPath, decision: "declined" });
      return;
    }
    const answer = await requestAnswer(trustQuestion(status));
    // From Settings a cancel is backing out of a dialog the user opened, not an answer.
    await recordAnswer(wtPath, status, answer === false && !declineOnCancel ? null : answer);
  } catch (err) {
    showToast(err instanceof Error ? err.message : "Could not change repository trust");
  }
}

/**
 * Asks to trust the worktree's repository, after `reason` says what is waiting on it. Resolves
 * true when the repository is trusted, already or by this answer. "Not Now" records it declined.
 */
export async function askToTrustRepo(
  wtPath: string,
  ask: { title: string; reason: ReactNode; confirmLabel: string },
): Promise<boolean> {
  const status = await getRepoTrust(wtPath);
  if (status.decision === "trusted") return true;
  const answer = await requestAnswer({
    title: ask.title,
    description: (
      <>
        <p className="mb-2">{ask.reason}</p>
        <TrustExplanation {...status} />
      </>
    ),
    confirmLabel: ask.confirmLabel,
    cancelLabel: "Not Now",
  });
  return recordAnswer(wtPath, status, answer);
}

/** The offers still to show, one at a time: a newer confirmation would cancel the one showing. */
let offers: Promise<void> = Promise.resolve();

/**
 * Says that a new worktree's `init.wt.sh` did not run because its repository is not trusted, and
 * offers to trust the repository and run it now. Offers queue, so worktrees created together each
 * get theirs; one whose repository was trusted meanwhile runs its hook without asking again.
 */
export function offerToRunInitHook(projectPath: string, wtPath: string): Promise<void> {
  offers = offers.then(() => offerOnce(projectPath, wtPath));
  return offers;
}

async function offerOnce(projectPath: string, wtPath: string): Promise<void> {
  try {
    const trusted = await askToTrustRepo(wtPath, {
      title: "Trust this repository and run init.wt.sh?",
      reason: (
        <>
          The new worktree <strong>{wtPath.split("/").pop()}</strong> was created without running
          the repository&rsquo;s <code>init.wt.sh</code>: hooks run in trusted repositories.
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
