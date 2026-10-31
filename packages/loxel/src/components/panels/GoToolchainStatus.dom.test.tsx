import { afterEach, describe, expect, jest, mock, test } from "bun:test";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import type { GoEnv, GoEnvResponse } from "@/api/go-env-model";

const ENV: GoEnv = {
  binary: "/usr/local/go/bin/go",
  version: "1.27.3",
  goroot: "/usr/local/go",
  gopath: "/home/me/go",
  gomodcache: "/home/me/go/pkg/mod",
  gomod: "/wt-a/go.mod",
  gowork: null,
  goflags: null,
  newerGoNeeded: null,
  newerToolchainSuggested: null,
};

let response: GoEnvResponse = { env: ENV };
const originalClient = await import("@/api/go-env-client");
const getGoEnv = jest.fn(async (_wtPath: string) => response);
const refreshGoEnv = jest.fn(async (_wtPath: string) => response);
mock.module("@/api/go-env-client", () => ({ ...originalClient, getGoEnv, refreshGoEnv }));

const originalLspClient = await import("@/lib/lsp-client");
const restartStoppedLanguageServers = jest.fn(() => {});
mock.module("@/lib/lsp-client", () => ({ ...originalLspClient, restartStoppedLanguageServers }));

let activePanel = {
  id: "codeeditor-/wt-a/main.go",
  params: { filePath: "/wt-a/main.go", worktreePath: "/wt-a" },
};
const originalToolsBar = await import("@/store/tools-bar");
mock.module("@/store/tools-bar", () => ({
  ...originalToolsBar,
  getCenterApi: () => ({ activePanel, onDidActivePanelChange: () => ({ dispose: () => {} }) }),
  subscribeCenterApi: () => () => {},
}));

const { GoToolchainStatus } = await import("./GoToolchainStatus");

afterEach(() => {
  cleanup();
  getGoEnv.mockClear();
  refreshGoEnv.mockClear();
  restartStoppedLanguageServers.mockClear();
  response = { env: ENV };
});

function renderStatus() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <GoToolchainStatus />
    </QueryClientProvider>,
  );
}

describe("GoToolchainStatus", () => {
  test("shows the version, with the go path, GOROOT and module file in its tooltip", async () => {
    renderStatus();
    const button = await screen.findByRole("button", { name: "Go 1.27.3" });
    expect(button.title).toContain("/usr/local/go/bin/go");
    expect(button.title).toContain("GOROOT: /usr/local/go");
    expect(button.title).toContain("Module: /wt-a/go.mod");
    expect(button.className).toContain("text-muted-foreground");
  });

  test("warns when go is missing", async () => {
    response = { env: null };
    renderStatus();
    const button = await screen.findByRole("button", { name: "Go not found" });
    expect(button.title).toContain("Go is not installed or not on your PATH");
    expect(button.className).toContain("text-warning");
  });

  test("warns when the project needs a newer Go, and says which", async () => {
    response = { env: { ...ENV, newerGoNeeded: { file: "go.mod", version: "1.99.0" } } };
    renderStatus();
    const button = await screen.findByRole("button", { name: "Go 1.27.3" });
    expect(button.title).toContain("go.mod needs Go 1.99.0");
    expect(button.className).toContain("text-warning");
  });

  test("only notes a newer toolchain line", async () => {
    response = { env: { ...ENV, newerToolchainSuggested: { file: "go.mod", version: "1.99.1" } } };
    renderStatus();
    const button = await screen.findByRole("button", { name: "Go 1.27.3" });
    expect(button.title).toContain("go.mod suggests Go 1.99.1");
    expect(button.className).toContain("text-muted-foreground");
  });

  test("clicking looks again, and restarts stopped servers once Go is found", async () => {
    renderStatus();
    fireEvent.click(await screen.findByRole("button", { name: "Go 1.27.3" }));
    await refreshGoEnv.mock.results[0]?.value;
    expect(refreshGoEnv).toHaveBeenCalledWith("/wt-a");
    await new Promise<void>((resolve) => {
      const wait = () => {
        if (restartStoppedLanguageServers.mock.calls.length > 0) resolve();
        else queueMicrotask(wait);
      };
      wait();
    });
  });

  test("clicking while Go is still missing restarts nothing", async () => {
    response = { env: null };
    renderStatus();
    fireEvent.click(await screen.findByRole("button", { name: "Go not found" }));
    const { refreshGoToolchain } = await import("@/lib/go-toolchain");
    await refreshGoToolchain("/wt-a");
    expect(restartStoppedLanguageServers).not.toHaveBeenCalled();
  });

  test("shows for go.mod and nothing for other files", async () => {
    activePanel = {
      id: "codeeditor-/wt-a/go.mod",
      params: { filePath: "/wt-a/go.mod", worktreePath: "/wt-a" },
    };
    const first = renderStatus();
    await screen.findByRole("button", { name: "Go 1.27.3" });
    first.unmount();

    activePanel = {
      id: "codeeditor-/wt-a/app.py",
      params: { filePath: "/wt-a/app.py", worktreePath: "/wt-a" },
    };
    const second = renderStatus();
    expect(second.container.textContent).toBe("");
  });
});
