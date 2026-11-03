import { expect, mock, test } from "bun:test";

let trusted = false;
const asked: string[] = [];
const ran: string[] = [];
let answer: (confirmed: boolean) => void = () => {};
let shown: () => void = () => {};
const firstShown = new Promise<void>((resolve) => {
  shown = resolve;
});

mock.module("@/api/repo-trust-client", () => ({
  getRepoTrust: () => Promise.resolve({ repository: "/repo", trusted, restrictions: [] }),
  setRepoTrust: () => {
    trusted = true;
    return Promise.resolve({ repository: "/repo", trusted, restrictions: [] });
  },
}));
mock.module("@/api/client", () => ({
  runInitHook: (_projectPath: string, wtPath: string) => {
    ran.push(wtPath);
    return Promise.resolve({ hookRan: true });
  },
}));
mock.module("@/components/ui/confirm-dialog-host", () => ({
  requestConfirmation: ({ title }: { title: string }) => {
    asked.push(title);
    return new Promise<boolean>((resolve) => {
      answer = resolve;
      shown();
    });
  },
}));
mock.module("@/components/ui/toast", () => ({ showToast: () => {} }));

const { offerToRunInitHook } = await import("./repo-trust-dialog");

test("offers wait their turn, and once trusted the rest run without asking", async () => {
  const first = offerToRunInitHook("/repo", "/repo/.worktrees/a");
  const second = offerToRunInitHook("/repo", "/repo/.worktrees/b");

  // The second waits for the first, which waits for its answer.
  await firstShown;
  expect(asked).toHaveLength(1);

  answer(true);
  await Promise.all([first, second]);

  expect(asked).toHaveLength(1);
  expect(ran).toEqual(["/repo/.worktrees/a", "/repo/.worktrees/b"]);
});
