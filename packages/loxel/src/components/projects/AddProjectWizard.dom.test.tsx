import { afterEach, beforeEach, describe, expect, jest, mock, test } from "bun:test";

import type { InitAction } from "@bizimind/wt/lib";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import type { AddProjectRequest, DetectPathResult, ProjectSetupResult } from "@/api/project-model";

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

const addProject = jest.fn(async (_req: AddProjectRequest): Promise<ProjectSetupResult> => added);
const originalClient = await import("@/api/client");
mock.module("@/api/client", () => ({
  ...originalClient,
  browse: jest.fn(async () => ({ path: "/", dirs: [] })),
  detectPath: jest.fn(async () => detected),
  addProject,
}));

const { AddProjectWizard } = await import("./AddProjectWizard");
const { openAddProjectWizard, useAddProjectWizardStore } =
  await import("@/store/add-project-wizard");
const { useProjectStore } = await import("@/store/projects");

const showAddedProject = jest.fn(async () => {});

beforeEach(() => {
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
    expect(addProject).toHaveBeenCalledWith({
      path: "/repos/shop.git",
      name: "shop",
      apply: ["worktree-metadata-on"],
    });
    expect(useAddProjectWizardStore.getState().isOpen).toBe(false);
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
