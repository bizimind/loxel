import { afterEach, describe, expect, jest, mock, test } from "bun:test";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import type { GoEnv, GoEnvResponse, GoToolchainChoiceRequest } from "@/api/go-env-model";
import { useCommandPaletteStore } from "@/store/command-palette";

const ENV: GoEnv = {
  binary: "/usr/local/go/bin/go",
  source: "path",
  version: "1.27.3",
  goroot: "/usr/local/go",
  gopath: "/home/me/go",
  gomodcache: "/home/me/go/pkg/mod",
  toolchainPlatform: "darwin-arm64",
  gomod: "/wt-a/go.mod",
  gowork: null,
  goflags: null,
  gopls: null,
  newerGoNeeded: null,
  newerToolchainSuggested: null,
};

let response: GoEnvResponse = { env: ENV, chosen: null };
const originalClient = await import("@/api/go-env-client");
const getGoEnv = jest.fn(async (_wtPath: string) => response);
const refreshGoEnv = jest.fn(async (_wtPath: string) => response);
const getGoToolchainCandidates = jest.fn(async (_wtPath: string) => ({
  candidates: [
    { path: "/home/me/sdk/go1.24.1/bin/go", version: "1.24.1", fromModuleCache: false },
    { path: "/home/me/go/pkg/mod/t/bin/go", version: "1.26.0", fromModuleCache: true },
  ],
  automatic: ENV,
  chosen: response.chosen,
}));
const setGoToolchainChoice = jest.fn(async (_request: GoToolchainChoiceRequest) => response);
mock.module("@/api/go-env-client", () => ({
  ...originalClient,
  getGoEnv,
  refreshGoEnv,
  getGoToolchainCandidates,
  setGoToolchainChoice,
}));

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
  getGoToolchainCandidates.mockClear();
  setGoToolchainChoice.mockClear();
  dismissPalette();
  response = { env: ENV, chosen: null };
});

function dismissPalette() {
  useCommandPaletteStore.getState().close();
}

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
    expect(button.title).toContain("gopls: bundled with Loxel");
    expect(button.className).toContain("text-muted-foreground");
  });

  test("names the user's gopls when that is the one in use", async () => {
    response = { env: { ...ENV, gopls: "/home/me/go/bin/gopls" }, chosen: null };
    renderStatus();
    const button = await screen.findByRole("button", { name: "Go 1.27.3" });
    expect(button.title).toContain("gopls: /home/me/go/bin/gopls");
  });

  test("warns when go is missing", async () => {
    response = { env: null, chosen: null };
    renderStatus();
    const button = await screen.findByRole("button", { name: "Go not found" });
    expect(button.title).toContain("Go is not installed or not on your PATH");
    expect(button.className).toContain("text-warning");
  });

  test("warns when the project needs a newer Go, and says which", async () => {
    response = {
      env: { ...ENV, newerGoNeeded: { file: "go.mod", version: "1.99.0" } },
      chosen: null,
    };
    renderStatus();
    const button = await screen.findByRole("button", { name: "Go 1.27.3" });
    expect(button.title).toContain("go.mod needs Go 1.99.0");
    expect(button.title).toContain("Running `go version` in the project from a terminal");
    expect(button.className).toContain("text-warning");
  });

  test("only notes a newer toolchain line", async () => {
    response = {
      env: { ...ENV, newerToolchainSuggested: { file: "go.mod", version: "1.99.1" } },
      chosen: null,
    };
    renderStatus();
    const button = await screen.findByRole("button", { name: "Go 1.27.3" });
    expect(button.title).toContain("go.mod suggests Go 1.99.1");
    expect(button.className).toContain("text-muted-foreground");
  });

  test("says a Go comes from the module cache", async () => {
    response = { env: { ...ENV, source: "module-cache", version: "1.26.0" }, chosen: null };
    renderStatus();
    const button = await screen.findByRole("button", { name: "Go 1.26.0" });
    expect(button.title).toContain("From the module cache");
    expect(button.className).toContain("text-muted-foreground");
  });

  test("says a Go was chosen", async () => {
    response = { env: { ...ENV, source: "chosen" }, chosen: ENV.binary };
    renderStatus();
    const button = await screen.findByRole("button", { name: "Go 1.27.3" });
    expect(button.title).toContain("Chosen for this worktree");
    expect(button.className).toContain("text-muted-foreground");
  });

  test("does not suggest a download that would not change a chosen Go", async () => {
    response = {
      env: { ...ENV, source: "chosen", newerGoNeeded: { file: "go.mod", version: "1.99.0" } },
      chosen: ENV.binary,
    };
    renderStatus();
    const button = await screen.findByRole("button", { name: "Go 1.27.3" });
    expect(button.title).toContain("stays in use until you select another");
    expect(button.title).not.toContain("go version");
  });

  test("warns when the chosen Go cannot be used, and names it", async () => {
    response = { env: ENV, chosen: "/gone/bin/go" };
    renderStatus();
    const button = await screen.findByRole("button", { name: "Go 1.27.3" });
    expect(button.title).toContain("The chosen Go /gone/bin/go cannot be used");
    expect(button.className).toContain("text-warning");
  });

  test("clicking offers detection, a path, and what was found, with no download", async () => {
    renderStatus();
    fireEvent.click(await screen.findByRole("button", { name: "Go 1.27.3" }));
    const items = await waitFor(() => {
      const { mode } = useCommandPaletteStore.getState();
      if (mode.kind !== "pick" || !mode.items) throw new Error("still loading");
      return mode.items;
    });
    expect(items.map((item) => item.label)).toEqual([
      "Use automatic detection",
      "Enter a path to Go…",
      "Go 1.24.1",
      "Go 1.26.0",
    ]);
    expect(items[3]?.description).toContain("Module cache");
    expect(items[0]?.current).toBe(true);
  });

  test("picking a Go or detection saves it, and restarts stopped servers", async () => {
    const { selectGoToolchain } = await import("@/lib/go-toolchain");
    const pick = async (id: string) => {
      const done = selectGoToolchain("/wt-a");
      await waitFor(() => {
        const { mode } = useCommandPaletteStore.getState();
        if (mode.kind !== "pick" || !mode.items) throw new Error("still loading");
      });
      useCommandPaletteStore.getState().submit(id);
      await done;
    };
    await pick("/home/me/sdk/go1.24.1/bin/go");
    expect(setGoToolchainChoice).toHaveBeenLastCalledWith({
      worktreePath: "/wt-a",
      goPath: "/home/me/sdk/go1.24.1/bin/go",
    });
    await pick("#automatic");
    expect(setGoToolchainChoice).toHaveBeenLastCalledWith({ worktreePath: "/wt-a", goPath: null });
    expect(restartStoppedLanguageServers).toHaveBeenCalled();
  });

  test("clicking looks again, and restarts stopped servers once Go is found", async () => {
    renderStatus();
    fireEvent.click(await screen.findByRole("button", { name: "Go 1.27.3" }));
    await refreshGoEnv.mock.results[0]?.value;
    expect(refreshGoEnv).toHaveBeenCalledWith("/wt-a");
    await waitFor(() => expect(restartStoppedLanguageServers).toHaveBeenCalled());
  });

  test("clicking while Go is still missing restarts nothing", async () => {
    response = { env: null, chosen: null };
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
