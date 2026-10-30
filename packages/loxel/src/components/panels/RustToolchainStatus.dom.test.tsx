import { afterEach, describe, expect, jest, mock, test } from "bun:test";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import type { RustToolchainResponse } from "@/api/rust-toolchain-model";

const ACTIVE: RustToolchainResponse = {
  toolchain: {
    status: "active",
    source: "default",
    name: "stable-aarch64-apple-darwin",
    version: "1.99.1",
    rustcPath: "/rustup/toolchains/stable-aarch64-apple-darwin/bin/rustc",
    sysroot: "/rustup/toolchains/stable-aarch64-apple-darwin",
    toolchainFile: null,
    tools: { cargo: "/cargo/bin/cargo", rustfmt: null, cargoClippy: null, rustSrc: false },
  },
  chosen: null,
};

let response = ACTIVE;
const originalClient = await import("@/api/client");
const getRustToolchain = jest.fn(async (_wtPath: string) => response);
mock.module("@/api/client", () => ({ ...originalClient, getRustToolchain }));

const originalLib = await import("@/lib/rust-toolchain");
const selectRustToolchain = jest.fn(async (_wtPath: string) => {});
mock.module("@/lib/rust-toolchain", () => ({ ...originalLib, selectRustToolchain }));

// The outgoing center right after a worktree switch: its active panel still shows a file of
// worktree A, while the global active worktree is already B.
const activePanel = {
  id: "codeeditor-/wt-a/src/main.rs",
  params: { filePath: "/wt-a/src/main.rs", worktreePath: "/wt-a" },
};
const originalToolsBar = await import("@/store/tools-bar");
mock.module("@/store/tools-bar", () => ({
  ...originalToolsBar,
  getCenterApi: () => ({ activePanel, onDidActivePanelChange: () => ({ dispose: () => {} }) }),
  subscribeCenterApi: () => () => {},
}));

const { useWorktreeStore } = await import("@/store/worktrees");
const { RustToolchainStatus } = await import("./RustToolchainStatus");

function renderStatus() {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <RustToolchainStatus />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  response = ACTIVE;
  getRustToolchain.mockClear();
  selectRustToolchain.mockClear();
});

describe("RustToolchainStatus", () => {
  test("shows and selects the toolchain of the active panel's worktree, not the active one", async () => {
    useWorktreeStore.setState({ activeWorktreePath: "/wt-b" });
    renderStatus();

    const button = await screen.findByRole("button", { name: "Rust 1.99.1 (stable)" });
    expect(getRustToolchain.mock.calls.map(([wtPath]) => wtPath)).toEqual(["/wt-a"]);
    expect(button.className).toContain("text-muted-foreground");
    fireEvent.click(button);
    expect(selectRustToolchain.mock.calls).toEqual([["/wt-a"]]);
  });

  test("warns about a pinned toolchain that is not installed and says what to run", async () => {
    response = {
      toolchain: {
        status: "not-installed",
        source: "toolchain-file",
        name: "1.70.0-aarch64-apple-darwin",
        toolchainFile: "/wt-a/rust-toolchain.toml",
      },
      chosen: null,
    };
    renderStatus();

    const button = await screen.findByRole("button", { name: "Rust 1.70.0 (not installed)" });
    expect(button.className).toContain("text-warning");
    expect(button.title).toContain("rustup toolchain install 1.70.0");
    expect(button.title).toContain("/wt-a/rust-toolchain.toml");
  });

  test("warns when no toolchain exists and says how to install Rust", async () => {
    response = { toolchain: { status: "none", rustupPath: null, detail: null }, chosen: null };
    renderStatus();

    const button = await screen.findByRole("button", { name: "Rust: no toolchain" });
    expect(button.className).toContain("text-warning");
    expect(button.title).toContain("https://rustup.rs");
  });

  test("warns when the chosen toolchain cannot be used", async () => {
    response = { ...ACTIVE, chosen: "1.84.0-aarch64-apple-darwin" };
    renderStatus();

    const button = await screen.findByRole("button", { name: "Rust 1.99.1 (stable)" });
    expect(button.className).toContain("text-warning");
    expect(button.title).toContain("1.84.0-aarch64-apple-darwin cannot be used");
  });
});
