import { afterEach, describe, expect, jest, mock, test } from "bun:test";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import type { JavaEnvResponse } from "@/api/java-env-model";

const JDK: NonNullable<JavaEnvResponse["env"]> = {
  source: "java-home",
  path: "/jdks/temurin-21/Contents/Home",
  majorVersion: 21,
  version: "21.0.5",
  implementor: "Eclipse Adoptium",
};

const originalClient = await import("@/api/client");
const getJavaEnv = jest.fn(async (_wtPath: string): Promise<JavaEnvResponse> => ({
  env: JDK,
  overridePath: null,
  ignoredJavaHome: null,
}));
mock.module("@/api/client", () => ({ ...originalClient, getJavaEnv }));

const originalRuntime = await import("@/lib/java-runtime");
const selectJavaRuntime = jest.fn(async (_wtPath: string) => {});
mock.module("@/lib/java-runtime", () => ({ ...originalRuntime, selectJavaRuntime }));

// The outgoing center right after a worktree switch: its active panel still shows a file of
// worktree A, while the global active worktree is already B.
const activePanel = {
  id: "codeeditor-/wt-a/src/App.java",
  params: { filePath: "/wt-a/src/App.java", worktreePath: "/wt-a" },
};
const originalToolsBar = await import("@/store/tools-bar");
mock.module("@/store/tools-bar", () => ({
  ...originalToolsBar,
  getCenterApi: () => ({ activePanel, onDidActivePanelChange: () => ({ dispose: () => {} }) }),
  subscribeCenterApi: () => () => {},
}));

const { useWorktreeStore } = await import("@/store/worktrees");
const { JavaRuntimeStatus } = await import("./JavaRuntimeStatus");

function renderStatus() {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <JavaRuntimeStatus />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  getJavaEnv.mockClear();
  selectJavaRuntime.mockClear();
});

describe("JavaRuntimeStatus", () => {
  test("shows and selects the JDK of the active panel's worktree, not the active one", async () => {
    useWorktreeStore.setState({ activeWorktreePath: "/wt-b" });
    renderStatus();

    const button = await screen.findByRole("button", { name: "Java 21.0.5 (Temurin)" });
    expect(getJavaEnv.mock.calls.map(([wtPath]) => wtPath)).toEqual(["/wt-a"]);
    expect(button.title).toContain(JDK.path);
    expect(button.title).toContain("Detected from JAVA_HOME");
    expect(button.className).toContain("text-muted-foreground");
    fireEvent.click(button);
    expect(selectJavaRuntime.mock.calls).toEqual([["/wt-a"]]);
  });

  test("says when JAVA_HOME was ignored", async () => {
    getJavaEnv.mockImplementationOnce(async () => ({
      env: { ...JDK, source: "install-location" },
      overridePath: null,
      ignoredJavaHome: "/opt/homebrew/opt/openjdk",
    }));
    renderStatus();

    const button = await screen.findByRole("button", { name: "Java 21.0.5 (Temurin)" });
    expect(button.title).toContain("JAVA_HOME (/opt/homebrew/opt/openjdk) is not a usable JDK");
    expect(button.className).toContain("text-muted-foreground");
  });

  test("warns when the chosen JDK has gone missing", async () => {
    getJavaEnv.mockImplementationOnce(async () => ({
      env: JDK,
      overridePath: "/jdks/removed",
      ignoredJavaHome: null,
    }));
    renderStatus();

    const button = await screen.findByRole("button", { name: "Java 21.0.5 (Temurin)" });
    expect(button.title).toContain("The chosen JDK /jdks/removed cannot be used");
    expect(button.className).toContain("text-warning");
  });

  test("says when no JDK was found", async () => {
    getJavaEnv.mockImplementationOnce(async () => ({
      env: null,
      overridePath: null,
      ignoredJavaHome: null,
    }));
    renderStatus();

    const button = await screen.findByRole("button", { name: "No JDK found" });
    expect(button.className).toContain("text-warning");
  });
});
