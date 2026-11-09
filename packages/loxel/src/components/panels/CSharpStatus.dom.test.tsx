import { afterEach, describe, expect, jest, mock, test } from "bun:test";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import type { CSharpStatusResponse } from "@/api/csharp-env-model";

const RUNNING: CSharpStatusResponse = {
  server: {
    kind: "running",
    target: "/wt-a/All.slnx",
    projects: ["/wt-a/App.csproj"],
    sdkVersion: "10.0.403",
  },
  chosen: null,
  chosenMissing: false,
};

const originalClient = await import("@/api/csharp-env-client");
const getCSharpStatus = jest.fn(async (_wtPath: string) => RUNNING);
mock.module("@/api/csharp-env-client", () => ({ ...originalClient, getCSharpStatus }));

const originalSolution = await import("@/lib/csharp-solution");
const selectCSharpSolution = jest.fn(async (_wtPath: string) => {});
mock.module("@/lib/csharp-solution", () => ({ ...originalSolution, selectCSharpSolution }));

// The outgoing center right after a worktree switch: its active panel still shows a file of
// worktree A, while the global active worktree is already B.
const activePanel = {
  id: "codeeditor-/wt-a/src/App.cs",
  params: { filePath: "/wt-a/src/App.cs", worktreePath: "/wt-a" },
};
const originalToolsBar = await import("@/store/tools-bar");
mock.module("@/store/tools-bar", () => ({
  ...originalToolsBar,
  getCenterApi: () => ({ activePanel, onDidActivePanelChange: () => ({ dispose: () => {} }) }),
  subscribeCenterApi: () => () => {},
}));

const { useWorktreeStore } = await import("@/store/worktrees");
const { CSharpStatus } = await import("./CSharpStatus");

function renderStatus(client = new QueryClient()) {
  return render(
    <QueryClientProvider client={client}>
      <CSharpStatus />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  getCSharpStatus.mockClear();
  selectCSharpSolution.mockClear();
});

describe("CSharpStatus", () => {
  test("shows and selects for the active panel's worktree, not the active one", async () => {
    useWorktreeStore.setState({ activeWorktreePath: "/wt-b" });
    renderStatus();
    const button = await screen.findByRole("button", { name: "C#: All.slnx" });
    expect(getCSharpStatus.mock.calls.map(([wtPath]) => wtPath)).toEqual(["/wt-a"]);
    expect(button.title).toContain(".NET SDK 10.0.403");
    expect(button.className).toContain("text-muted-foreground");
    fireEvent.click(button);
    expect(selectCSharpSolution.mock.calls).toEqual([["/wt-a"]]);
  });

  test("warns about a missing step, and gives its words on hover", async () => {
    getCSharpStatus.mockImplementationOnce(async () => ({
      ...RUNNING,
      server: { kind: "blocked", block: "not-restored", message: "Run `dotnet restore`." },
    }));
    renderStatus();
    const button = await screen.findByRole("button", { name: "C#: Not restored" });
    expect(button.title).toContain("Run `dotnet restore`.");
    expect(button.className).toContain("text-warning");
  });

  test("shows nothing in a repository with no project", async () => {
    getCSharpStatus.mockImplementationOnce(async () => ({
      ...RUNNING,
      server: { kind: "no-project" },
    }));
    const client = new QueryClient();
    const { container } = renderStatus(client);
    // Until the answer has rendered, an empty item says nothing.
    await waitFor(() => {
      const [query] = client.getQueryCache().getAll();
      expect(query?.state.status).toBe("success");
    });
    await act(async () => {});
    expect(container.textContent).toBe("");
  });
});
