import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { render, screen } from "@testing-library/react";

import type { EnrichedProject } from "@/api/project-model";
import { useProjectStore } from "@/store/projects";
import { useWorktreeStore } from "@/store/worktrees";

mock.module("../projects/AddProjectWizard", () => ({ AddProjectWizard: () => null }));

const { Sidebar } = await import("./Sidebar");

const project: EnrichedProject = {
  id: "regular",
  path: "/repo",
  name: "regular-repo",
  addedAt: "2026-01-01T00:00:00.000Z",
  isBare: false,
  worktreesDir: "/repo/.worktrees",
  worktrees: [
    {
      path: "/repo/.worktrees/topic",
      branch: "topic",
      commit: "abc",
      isMain: false,
      createdAt: null,
      wtName: "topic",
    },
  ],
};

beforeEach(() => {
  useProjectStore.setState({
    projects: [project],
    sidebarExpanded: true,
    expandedProjectIds: [project.id],
  });
  useWorktreeStore.setState({
    activeWorktreePath: project.path,
    byProject: {
      [project.path]: { worktrees: project.worktrees, worktreesDir: project.worktreesDir },
    },
  });
});

afterEach(() => {
  useProjectStore.setState({ projects: [], expandedProjectIds: [] });
  useWorktreeStore.getState().reset();
});

describe("Sidebar regular-repository worktrees", () => {
  test("shows linked worktrees and the create action under a regular repo", () => {
    render(<Sidebar />);

    expect(screen.getByText("regular-repo")).toBeDefined();
    expect(screen.getByText("topic")).toBeDefined();
    expect(screen.getByText("Add worktree")).toBeDefined();
  });
});
