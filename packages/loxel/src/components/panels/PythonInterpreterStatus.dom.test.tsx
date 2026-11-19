import { afterEach, describe, expect, jest, mock, test } from "bun:test";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { localRef } from "@/api/local-server";
import type { PythonEnvResponse } from "@/api/python-env-model";
import { formatWorktreeRef, type WorktreeRef } from "@/api/worktree-ref";

const ENV: PythonEnvResponse = {
  env: {
    pythonPath: "/wt-a/api/.venv/bin/python",
    envPath: "/wt-a/api/.venv",
    version: "3.12.1",
    source: "venv",
  },
  overridePath: null,
};

const originalClient = await import("@/api/python-env-client");
const getPythonEnv = jest.fn(async (_wtPath: string) => ENV);
mock.module("@/api/python-env-client", () => ({ ...originalClient, getPythonEnv }));

const originalInterpreter = await import("@/lib/python-interpreter");
const selectPythonInterpreter = jest.fn(async (_wt: WorktreeRef) => {});
mock.module("@/lib/python-interpreter", () => ({
  ...originalInterpreter,
  selectPythonInterpreter,
}));

// The outgoing center right after a worktree switch: its active panel still shows a file of
// worktree A, while the global active worktree is already B.
const activePanel = {
  id: "codeeditor-/wt-a/api/app.py",
  params: { filePath: "/wt-a/api/app.py", worktreePath: "/wt-a" },
};
/** The layout the center shows, whose server holds its panels' worktrees. */
const centerLayoutKey = formatWorktreeRef(localRef("/wt-a"));
const originalToolsBar = await import("@/store/tools-bar");
mock.module("@/store/tools-bar", () => ({
  ...originalToolsBar,
  getCenterApi: () => ({ activePanel, onDidActivePanelChange: () => ({ dispose: () => {} }) }),
  getCenterApiLayoutKey: () => centerLayoutKey,
  subscribeCenterApi: () => () => {},
}));

const { activeWorktreeFields, useWorktreeStore } = await import("@/store/worktrees");
const { PythonInterpreterStatus } = await import("./PythonInterpreterStatus");

afterEach(() => {
  cleanup();
  getPythonEnv.mockClear();
  selectPythonInterpreter.mockClear();
});

describe("PythonInterpreterStatus", () => {
  test("shows and selects the interpreter of the active panel's worktree, not the active one", async () => {
    useWorktreeStore.setState(activeWorktreeFields(localRef("/wt-b")));
    render(
      <QueryClientProvider client={new QueryClient()}>
        <PythonInterpreterStatus />
      </QueryClientProvider>,
    );

    const button = await screen.findByRole("button", { name: "Python 3.12.1 (api/.venv)" });
    expect(getPythonEnv.mock.calls.map(([wtPath]) => wtPath)).toEqual(["/wt-a"]);
    fireEvent.click(button);
    expect(selectPythonInterpreter.mock.calls).toEqual([[localRef("/wt-a")]]);
  });
});
