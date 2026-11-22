import { afterEach, beforeEach, describe, expect, jest, mock, test } from "bun:test";

import type { InitAction } from "@bizimind/wt/lib";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { localServerId } from "@/api/local-server";
import type { AddProjectRequest, DetectPathResult, ProjectSetupResult } from "@/api/project-model";
import type { RepoTrustTarget } from "@/api/repo-trust-client";
import type { RepoTrustDecision } from "@/api/repo-trust-model";

const fetchRefspec: InitAction = {
  id: "fetch-refspec",
  check: "fetch-refspec",
  title: "Add origin's fetch refspec, fetch, and record origin/HEAD",
  recommended: true,
  recommendation: "Gives wt the origin/* branches new worktrees start from",
  tradeoffs: [],
  commands: ["git config remote.origin.fetch +refs/heads/*:refs/remotes/origin/*"],
};
const metadataOn: InitAction = {
  id: "worktree-metadata-on",
  check: "worktree-metadata",
  title: "Turn on per-worktree config (extensions.worktreeConfig)",
  recommended: false,
  recommendation: "Only needed for nesting worktrees",
  tradeoffs: [],
  commands: ["git config extensions.worktreeConfig true"],
};
const detected: DetectPathResult = {
  type: "git-repo-bare",
  path: "/repos/shop.git",
  name: "shop",
  setup: {
    checks: [
      {
        id: "fetch-refspec",
        status: "warn",
        title: "Fetch refspec",
        summary: "origin has no fetch refspec",
        affects: [],
        fixable: true,
      },
      {
        id: "worktree-metadata",
        status: "info",
        title: "Worktree metadata",
        summary: "Per-worktree config is off",
        affects: [],
        fixable: true,
      },
    ],
    actions: [fetchRefspec, metadataOn],
  },
};
const added: ProjectSetupResult = {
  id: "p1",
  path: "/repos/shop.git",
  name: "shop",
  addedAt: "2026-01-01T00:00:00.000Z",
  isBare: true,
};

const addProject = jest.fn(
  async (_server: string, _req: AddProjectRequest): Promise<ProjectSetupResult> => added,
);
const originalClient = await import("@/api/client");
mock.module("@/api/client", () => ({
  ...originalClient,
  browse: jest.fn(async () => ({ path: "/", dirs: [] })),
  detectPath: jest.fn(async () => detected),
  addProject,
}));

let trust: RepoTrustDecision = "undecided";
const setRepoTrust = jest.fn(
  async (_target: RepoTrustTarget, choice: { decision: RepoTrustDecision }) => {
    trust = choice.decision;
    return { repository: "/repos/shop.git", decision: trust, restrictions: [] };
  },
);
mock.module("@/api/repo-trust-client", () => ({
  getRepoTrust: jest.fn(async () => ({
    repository: "/repos/shop.git",
    decision: trust,
    restrictions: [],
  })),
  setRepoTrust,
}));

const { AddProjectWizard } = await import("./AddProjectWizard");
const { ConfirmDialogHost } = await import("@/components/ui/confirm-dialog-host");
const { openAddProjectWizard, useAddProjectWizardStore } =
  await import("@/store/add-project-wizard");
const { useProjectStore } = await import("@/store/projects");

const showAddedProject = jest.fn(async () => {});

beforeEach(() => {
  trust = "undecided";
  setRepoTrust.mockClear();
  addProject.mockClear();
  showAddedProject.mockClear();
  useProjectStore.setState({ showAddedProject });
  useAddProjectWizardStore.setState({ isOpen: false });
});

afterEach(cleanup);

async function detectBareRepo(): Promise<void> {
  act(() => openAddProjectWizard());
  fireEvent.change(screen.getByPlaceholderText("~/projects/my-app or https://github.com/..."), {
    target: { value: "/repos/shop.git" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Go" }));
  await screen.findByText("Fetch refspec");
}

describe("AddProjectWizard", () => {
  test("adds an existing repository with the fixes left checked, then shows it", async () => {
    render(<AddProjectWizard />);
    await detectBareRepo();

    expect(screen.getByLabelText(fetchRefspec.title)).toBeChecked();
    expect(screen.getByLabelText("Turn on worktree nesting")).toBeChecked();
    fireEvent.click(screen.getByLabelText(fetchRefspec.title));
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    await waitFor(() => expect(showAddedProject).toHaveBeenCalledWith(added));
    expect(addProject).toHaveBeenCalledWith(localServerId(), {
      path: "/repos/shop.git",
      name: "shop",
      apply: ["worktree-metadata-on"],
    });
    expect(useAddProjectWizardStore.getState().isOpen).toBe(false);
    expect(setRepoTrust).not.toHaveBeenCalled();
  });

  test("asks to trust the repository first when a fix contacts its remote", async () => {
    render(
      <>
        <AddProjectWizard />
        <ConfirmDialogHost />
      </>,
    );
    await detectBareRepo();
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    fireEvent.click(await screen.findByRole("button", { name: "Trust and Add" }));

    await waitFor(() => expect(showAddedProject).toHaveBeenCalledWith(added));
    expect(setRepoTrust).toHaveBeenCalledWith(
      { server: localServerId(), repository: "/repos/shop.git" },
      { decision: "trusted" },
    );
    expect(addProject.mock.calls[0]?.[1].apply).toEqual(["fetch-refspec", "worktree-metadata-on"]);
  });

  test("not trusted, adds the project with the same fixes for the server to skip", async () => {
    render(
      <>
        <AddProjectWizard />
        <ConfirmDialogHost />
      </>,
    );
    await detectBareRepo();
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    fireEvent.click(await screen.findByRole("button", { name: "Not Now" }));

    await waitFor(() => expect(showAddedProject).toHaveBeenCalledWith(added));
    expect(trust).toBe("declined");
    expect(addProject.mock.calls[0]?.[1].apply).toEqual(["fetch-refspec", "worktree-metadata-on"]);
  });

  test("opens fresh each time, without the last opening's detection", async () => {
    render(<AddProjectWizard />);
    await detectBareRepo();
    act(() => useAddProjectWizardStore.getState().close());

    act(() => openAddProjectWizard());
    expect(screen.queryByText("Fetch refspec")).toBeNull();
    expect(screen.getByPlaceholderText("~/projects/my-app or https://github.com/...")).toHaveValue(
      "",
    );
  });
});
