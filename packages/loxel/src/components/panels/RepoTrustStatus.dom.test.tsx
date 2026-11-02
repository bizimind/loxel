import { afterEach, beforeEach, describe, expect, jest, mock, test } from "bun:test";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import type { RepoTrustStatus as Status } from "@/api/repo-trust-model";
import { queryKeys } from "@/queries/query-keys";

const originalDialog = await import("@/lib/repo-trust-dialog");
const manageRepoTrust = jest.fn(async (_wtPath: string) => {});
mock.module("@/lib/repo-trust-dialog", () => ({ ...originalDialog, manageRepoTrust }));

const { RepoTrustStatus } = await import("./RepoTrustStatus");
const { useWorktreeStore } = await import("@/store/worktrees");

const WT = "/repo/wt";

function renderStatus(status: Status) {
  const client = new QueryClient();
  client.setQueryData(queryKeys.repoTrust(null, WT), status);
  return render(
    <QueryClientProvider client={client}>
      <RepoTrustStatus />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  useWorktreeStore.setState({ activeWorktreePath: WT });
  manageRepoTrust.mockClear();
});

afterEach(cleanup);

describe("RepoTrustStatus", () => {
  test("stays quiet in an untrusted repository nothing is waiting on", () => {
    renderStatus({ repository: "/quiet", trusted: false, restrictions: [] });
    expect(screen.queryByRole("button")).toBeNull();
  });

  test("shows what is restricted and asks on click", () => {
    renderStatus({
      repository: "/restricted",
      trusted: false,
      restrictions: ["Build scripts don't run."],
    });
    const button = screen.getByRole("button", { name: "Restricted" });
    expect(button.title).toContain("Build scripts don't run.");
    fireEvent.click(button);
    expect(manageRepoTrust).toHaveBeenCalledWith(WT);
  });

  test("a trusted repository offers revoking", () => {
    renderStatus({ repository: "/trusted", trusted: true, restrictions: [] });
    const button = screen.getByRole("button");
    expect(button.title).toContain("stop trusting");
    expect(button.textContent).toBe("");
  });
});
