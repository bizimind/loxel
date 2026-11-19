import { afterEach, describe, expect, test } from "bun:test";

import { localServerId } from "@/api/local-server";
import type { EnrichedProject } from "@/api/project-model";
import { toServerId } from "@/api/worktree-ref";

import {
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  clampSidebarWidth,
  deriveProject,
  useProjectStore,
  withServerProjects,
} from "./projects";

function project(path: string, worktreePaths: string[]): EnrichedProject {
  return {
    id: path,
    path,
    name: path,
    addedAt: "2026-01-01T00:00:00.000Z",
    isBare: false,
    worktreesDir: `${path}/.worktrees`,
    worktreeMetadata: false,
    worktrees: worktreePaths.map((worktreePath) => ({
      path: worktreePath,
      branch: "topic",
      commit: "abc",
      isMain: false,
      createdAt: null,
    })),
  };
}

describe("deriveProject", () => {
  test("uses explicit membership for a WT_DIR outside the project", () => {
    const externalWorktree = "/tmp/worktrees/project/topic";
    const owner = project("/repos/project", [externalWorktree]);

    expect(deriveProject(externalWorktree, [owner])).toBe(owner);
  });

  test("does not match a sibling path with the same string prefix", () => {
    expect(deriveProject("/repos/project-other/topic", [project("/repos/project", [])])).toBeNull();
  });
});

describe("clampSidebarWidth", () => {
  test("keeps widths inside the allowed range", () => {
    expect(clampSidebarWidth(320)).toBe(320);
    expect(clampSidebarWidth(SIDEBAR_MIN_WIDTH - 50)).toBe(SIDEBAR_MIN_WIDTH);
    expect(clampSidebarWidth(SIDEBAR_MAX_WIDTH + 50)).toBe(SIDEBAR_MAX_WIDTH);
  });

  test("rounds fractional pointer widths", () => {
    expect(clampSidebarWidth(300.6)).toBe(301);
  });

  test("falls back to the default for non-finite values", () => {
    expect(clampSidebarWidth(Number.NaN)).toBe(SIDEBAR_DEFAULT_WIDTH);
    expect(clampSidebarWidth(Number.POSITIVE_INFINITY)).toBe(SIDEBAR_DEFAULT_WIDTH);
  });
});

describe("withServerProjects", () => {
  const [a, b] = [toServerId("server-a"), toServerId("server-b")];
  const on = (server: typeof a, path: string) => ({ ...project(path, []), server });
  const names = (list: ReturnType<typeof withServerProjects>) =>
    list.map((p) => `${p.server}:${p.path}`);

  test("replaces only that server's projects, in their place, keeping the other's", () => {
    const projects = [on(a, "/x"), on(b, "/repo"), on(b, "/y"), on(a, "/z")];

    // The same path on the other server is not touched.
    const next = withServerProjects(projects, b, [on(b, "/new")]);

    expect(names(next)).toEqual(["server-a:/x", "server-b:/new", "server-a:/z"]);
  });

  test("adds a server listed for the first time after the others", () => {
    expect(names(withServerProjects([on(a, "/repo")], b, [on(b, "/repo")]))).toEqual([
      "server-a:/repo",
      "server-b:/repo",
    ]);
  });
});

describe("the persisted sidebar state", () => {
  afterEach(() =>
    useProjectStore.setState({ projects: [], expandedProjectIds: [], autoExpandedProjectIds: [] }),
  );

  test("names only the window's server's projects, keeping ids of none listed", () => {
    useProjectStore.setState({
      projects: [
        { ...project("/here", []), id: "here", server: localServerId() },
        { ...project("/there", []), id: "there", server: toServerId("other-server") },
      ],
      expandedProjectIds: ["here", "there", "not-loaded"],
      autoExpandedProjectIds: ["there", "here"],
    });

    const persisted = useProjectStore.persist.getOptions().partialize?.(useProjectStore.getState());

    expect(persisted).toMatchObject({
      expandedProjectIds: ["here", "not-loaded"],
      autoExpandedProjectIds: ["here"],
    });
    // Still expanded here, only not stored on the window's server.
    expect(useProjectStore.getState().expandedProjectIds).toContain("there");
  });
});
