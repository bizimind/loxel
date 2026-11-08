import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { RepoTrustDecision, RepoTrustStatus } from "@/api/repo-trust-model";

let decision: RepoTrustDecision = "undecided";
const asked: string[] = [];
const ran: string[] = [];
const sent: string[] = [];
let answer: (answer: boolean | null) => void = () => {};
let shown: () => void = () => {};
let nextShown = new Promise<void>((resolve) => {
  shown = resolve;
});

function status(): RepoTrustStatus {
  return { repository: "/repo", decision, restrictions: [] };
}

mock.module("@/api/repo-trust-client", () => ({
  getRepoTrust: () => Promise.resolve(status()),
  setRepoTrust: (request: { decision: RepoTrustDecision; unlessTrusted?: boolean }) => {
    sent.push(request.unlessTrusted ? `${request.decision} unless trusted` : request.decision);
    decision = request.decision;
    return Promise.resolve(status());
  },
}));
mock.module("@/api/client", () => ({
  runInitHook: (_projectPath: string, wtPath: string) => {
    ran.push(wtPath);
    return Promise.resolve({ hookRan: true });
  },
}));
mock.module("@/components/ui/confirm-dialog-host", () => ({
  requestAnswer: ({ title }: { title: string }) => {
    asked.push(title);
    return new Promise<boolean | null>((resolve) => {
      answer = resolve;
      shown();
    });
  },
}));
mock.module("@/components/ui/toast", () => ({ showToast: () => {} }));

const { askToTrustRepo, manageRepoTrust, offerToRunInitHook } = await import("./repo-trust-dialog");

/** Wait for the next question, then answer it. */
async function answerNext(value: boolean | null): Promise<void> {
  await nextShown;
  nextShown = new Promise<void>((resolve) => {
    shown = resolve;
  });
  answer(value);
}

const ASK = { title: "Trust?", reason: "Hooks wait.", confirmLabel: "Trust" };

beforeEach(() => {
  decision = "undecided";
  asked.length = 0;
  ran.length = 0;
  sent.length = 0;
});

test("offers wait their turn, and once trusted the rest run without asking", async () => {
  const first = offerToRunInitHook("/repo", "/repo/.worktrees/a");
  const second = offerToRunInitHook("/repo", "/repo/.worktrees/b");

  // The second waits for the first, which waits for its answer.
  await answerNext(true);
  await Promise.all([first, second]);

  expect(asked).toHaveLength(1);
  expect(ran).toEqual(["/repo/.worktrees/a", "/repo/.worktrees/b"]);
});

describe("declining", () => {
  test("Not Now records the repository as declined, once", async () => {
    const first = askToTrustRepo("/repo", ASK);
    await answerNext(false);
    expect(await first).toBe(false);
    // Unless trusted: another window may have trusted it while the question was open.
    expect(sent).toEqual(["declined unless trusted"]);

    const again = askToTrustRepo("/repo", ASK);
    await answerNext(false);
    await again;
    expect(sent).toEqual(["declined unless trusted"]);
  });

  test("a question another one replaced records nothing", async () => {
    const asking = askToTrustRepo("/repo", ASK);
    await answerNext(null);
    expect(await asking).toBe(false);
    expect(sent).toEqual([]);
  });

  test("stopping trust records the repository as declined", async () => {
    decision = "trusted";
    const managing = manageRepoTrust("/repo");
    await answerNext(true);
    await managing;
    expect(asked).toEqual(["Stop trusting this repository?"]);
    expect(sent).toEqual(["declined"]);
  });

  test("cancelling from Settings is not an answer", async () => {
    const managing = manageRepoTrust("/repo", { declineOnCancel: false });
    await answerNext(false);
    await managing;
    expect(asked).toEqual(["Trust this repository?"]);
    expect(sent).toEqual([]);
  });
});
