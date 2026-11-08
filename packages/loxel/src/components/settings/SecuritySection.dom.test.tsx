import { afterEach, beforeEach, describe, expect, jest, mock, test } from "bun:test";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";

import type { RepoTrustEntry } from "@/api/repo-trust-model";
import { queryKeys } from "@/queries/query-keys";

const originalClient = await import("@/api/repo-trust-client");
const forgetRepoTrust = jest.fn(async (_id: string) => {});
mock.module("@/api/repo-trust-client", () => ({ ...originalClient, forgetRepoTrust }));
const originalDialog = await import("@/lib/repo-trust-dialog");
const manageRepoTrust = jest.fn(async (_wtPath: string, _options?: object) => {});
mock.module("@/lib/repo-trust-dialog", () => ({ ...originalDialog, manageRepoTrust }));

const { SecuritySection } = await import("./SecuritySection");

function entry(repository: string, fields: Partial<RepoTrustEntry>): RepoTrustEntry {
  return {
    id: `git:${repository}/.git`,
    repository,
    worktreePath: repository,
    decision: "undecided",
    stale: false,
    restrictions: [],
    ...fields,
  };
}

const REPOSITORIES: RepoTrustEntry[] = [
  entry("/code/declined", { decision: "declined" }),
  entry("/code/gone", { decision: "trusted", stale: true, worktreePath: null }),
  entry("/code/new", { restrictions: ["Build scripts don't run.", "mypy doesn't run."] }),
  entry("/code/trusted", { decision: "trusted" }),
];

function renderSection() {
  const client = new QueryClient();
  // Served from the cache, so nothing waits on a fetch.
  client.setQueryData(queryKeys.repoTrustList(), { repositories: REPOSITORIES });
  client.setQueryDefaults(queryKeys.repoTrustList(), { staleTime: Infinity });
  render(
    <QueryClientProvider client={client}>
      <SecuritySection />
    </QueryClientProvider>,
  );
}

function row(repository: string): HTMLElement {
  return screen.getByRole("listitem", { name: repository });
}

function shownRepositories(): string[] {
  const list = screen.queryByRole("list", { name: "Repositories" });
  if (!list) return [];
  return within(list)
    .getAllByRole("listitem", { name: /^\/code\// })
    .map((item) => item.getAttribute("aria-label") ?? "");
}

beforeEach(() => {
  forgetRepoTrust.mockClear();
  manageRepoTrust.mockClear();
});

afterEach(cleanup);

describe("Settings > Security repository trust", () => {
  test("lists every repository with its answer, restrictions one per line", () => {
    renderSection();
    expect(shownRepositories()).toEqual(REPOSITORIES.map((e) => e.repository));
    const restricted = within(row("/code/new")).getByRole("list", { name: "Restricted" });
    expect(
      within(restricted)
        .getAllByRole("listitem")
        .map((li) => li.textContent),
    ).toEqual(["Build scripts don't run.", "mypy doesn't run."]);
    expect(within(row("/code/new")).getByText("Not decided")).toBeInTheDocument();
    expect(within(row("/code/gone")).getByText(/No longer applies/)).toBeInTheDocument();
  });

  test("filters by answer and by folder", () => {
    renderSection();
    fireEvent.click(screen.getByRole("button", { name: "Trusted (2)" }));
    expect(shownRepositories()).toEqual(["/code/gone", "/code/trusted"]);

    fireEvent.click(screen.getByRole("button", { name: "All (4)" }));
    fireEvent.change(screen.getByLabelText("Filter repositories by folder"), {
      target: { value: "DECL" },
    });
    expect(shownRepositories()).toEqual(["/code/declined"]);
  });

  test("each row offers the changes that apply to it", () => {
    renderSection();
    const actions = (repository: string) =>
      within(row(repository))
        .queryAllByRole("button")
        .map((button) => button.textContent);
    expect(actions("/code/trusted")).toEqual(["Stop Trusting"]);
    expect(actions("/code/declined")).toEqual(["Trust", "Forget"]);
    expect(actions("/code/new")).toEqual(["Trust"]);
    // No project uses it, so there is nothing to trust through: it can only be forgotten.
    expect(actions("/code/gone")).toEqual(["Forget"]);
  });

  test("trust changes go through the trust dialog, and Forget clears the answer", () => {
    renderSection();
    fireEvent.click(within(row("/code/declined")).getByRole("button", { name: "Trust" }));
    expect(manageRepoTrust).toHaveBeenCalledWith("/code/declined", { declineOnCancel: false });

    fireEvent.click(within(row("/code/trusted")).getByRole("button", { name: "Stop Trusting" }));
    expect(manageRepoTrust).toHaveBeenCalledWith("/code/trusted", { declineOnCancel: false });

    fireEvent.click(within(row("/code/gone")).getByRole("button", { name: "Forget" }));
    expect(forgetRepoTrust).toHaveBeenCalledWith("git:/code/gone/.git");
  });
});
