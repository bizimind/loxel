/**
 * The diff viewer panel's sources: a patch renders from its own hunks in both layouts without
 * asking the server or git, and the worktree's git diff keeps its query and side-by-side view.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

import type { DiffInfo, FileDiff } from "@/api/diff-model";
import type { DiffSource } from "@/store/worktree-repository";

/** The files the side-by-side view was rendered for, with the refs it was given */
let sideBySide: { path: string; oldRef?: string; newRef?: string; worktreePath?: string }[] = [];
mock.module("./GitSideBySideDiffView", () => ({
  GitSideBySideDiffView: (props: {
    file: FileDiff;
    oldRef?: string;
    newRef?: string;
    worktreePath?: string;
  }) => {
    sideBySide.push({
      path: props.file.newPath,
      oldRef: props.oldRef,
      newRef: props.newRef,
      worktreePath: props.worktreePath,
    });
    return <div data-testid="side-by-side" />;
  },
}));

/** The sources the diff query was asked for, and the diff it answers with */
let queriedSources: (DiffSource | null)[] = [];
let serverDiff: DiffInfo | undefined;
const actualQueries = await import("@/queries/use-repo-queries");
mock.module("@/queries/use-repo-queries", () => ({
  ...actualQueries,
  useDiffQuery: (source: DiffSource | null) => {
    queriedSources.push(source);
    return { data: serverDiff, isLoading: false };
  },
}));

const WT = "/repo";
let reviewWorktreePath: string | undefined;
mock.module("@/hooks/useReviewContext", () => ({
  useReviewContext: () => ({ commitHash: undefined, worktreePath: reviewWorktreePath }),
}));

const { DiffViewerPanel } = await import("./DiffViewerPanel");
const { useUIStore } = await import("@/store/ui");
const { getCurrentRepositoryStore } = await import("@/store/worktree-repository");
const { useWorktreeStore } = await import("@/store/worktrees");

const PATCH = [
  "--- a/src/app.ts",
  "+++ b/src/app.ts",
  "@@ -10,3 +10,3 @@ export function app() {",
  "   const port = 80;",
  "-  listen(port);",
  "+  listen(port, host);",
  "   return port;",
  "--- a/README.md",
  "+++ b/README.md",
  "@@ -1 +1,2 @@",
  " # App",
  "+Served on a host.",
].join("\n");

function renderPatch(patch = PATCH) {
  return render(<DiffViewerPanel source={{ type: "patch", patch, sourcePath: "docs/notes.md" }} />);
}

/** The rows of the shown hunks' tables */
function rows(container: HTMLElement): HTMLTableRowElement[] {
  return [...container.querySelectorAll("tr")];
}

beforeEach(() => {
  sideBySide = [];
  queriedSources = [];
  serverDiff = undefined;
  reviewWorktreePath = undefined;
  useUIStore.getState().setDiffViewMode("unified");
  useWorktreeStore.setState({ activeWorktreePath: WT });
});
afterEach(cleanup);

describe("patch source", () => {
  test("renders the patch's hunks unified, one file at a time, without querying git", () => {
    const { container } = renderPatch();
    expect(screen.getByText("src/app.ts")).toBeInTheDocument();
    expect(screen.getByText("File 1 of 2")).toBeInTheDocument();
    expect(rows(container)).toHaveLength(4);
    expect(container.querySelector("tr.diff-line-del")?.textContent).toContain("11");
    expect(container.querySelector("tr.diff-line-add")?.textContent).toContain(
      "listen(port, host);",
    );
    // Nothing to read the lines above the hunk from.
    expect(screen.queryByText(/lines hidden/)).toBeNull();

    fireEvent.click(screen.getByTitle("Next file"));
    expect(screen.getByText("README.md")).toBeInTheDocument();
    expect(screen.getByText("File 2 of 2")).toBeInTheDocument();

    expect(queriedSources).toEqual([]);
    expect(sideBySide).toEqual([]);
  });

  test("renders split from hunks alone, pairing removed and added lines", () => {
    useUIStore.getState().setDiffViewMode("split");
    const { container } = renderPatch();
    const tables = container.querySelectorAll("table");
    expect(tables).toHaveLength(2);
    expect(tables[0]!.querySelectorAll("tr")).toHaveLength(3);
    expect(tables[0]!.textContent).toContain("listen(port);");
    expect(tables[1]!.textContent).toContain("listen(port, host);");
    expect(sideBySide).toEqual([]);

    act(() => useUIStore.getState().setDiffViewMode("unified"));
    expect(container.querySelectorAll("table")).toHaveLength(1);
  });

  test("titles a headerless snippet, and shows no changes for text without a diff", () => {
    const { unmount } = renderPatch("-old line\n+new line\n");
    expect(screen.getByText("Patch")).toBeInTheDocument();
    unmount();

    renderPatch("not a diff");
    expect(screen.getByText("No changes")).toBeInTheDocument();
  });
});

describe("git source", () => {
  const FILE: FileDiff = {
    oldPath: "src/app.ts",
    newPath: "src/app.ts",
    status: "modified",
    hunks: [
      {
        oldStart: 1,
        oldLines: 1,
        newStart: 1,
        newLines: 1,
        header: "@@ -1 +1 @@",
        lines: [
          { type: "delete", content: "a", oldLineNumber: 1 },
          { type: "add", content: "b", newLineNumber: 1 },
        ],
      },
    ],
    isBinary: false,
    additions: 1,
    deletions: 1,
  };

  test("shows the worktree's selected changes from the diff query", () => {
    const source: DiffSource = { type: "uncommitted", worktree: WT };
    getCurrentRepositoryStore().getState().setDiffSource(source);
    serverDiff = { files: [FILE], baseRef: "abc1234" };

    const { container } = render(<DiffViewerPanel source={{ type: "git" }} />);
    expect(queriedSources.at(-1)).toEqual(source);
    expect(screen.getByText("src/app.ts")).toBeInTheDocument();
    expect(rows(container)).toHaveLength(2);
  });

  test("splits with the side-by-side view against the diff's base and worktree", () => {
    getCurrentRepositoryStore().getState().setDiffSource({ type: "uncommitted", worktree: WT });
    serverDiff = { files: [FILE], baseRef: "abc1234" };
    reviewWorktreePath = WT;
    useUIStore.getState().setDiffViewMode("split");

    render(<DiffViewerPanel source={{ type: "git" }} />);
    expect(screen.getByTestId("side-by-side")).toBeInTheDocument();
    expect(sideBySide.at(-1)).toEqual({
      path: "src/app.ts",
      oldRef: "abc1234",
      newRef: undefined,
      worktreePath: WT,
    });
  });
});
