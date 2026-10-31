import { afterEach, describe, expect, jest, mock, test } from "bun:test";

import type { RustToolchainCandidatesResponse } from "@/api/rust-toolchain-model";

const STATUS = { toolchain: { status: "none", rustupPath: null, detail: null }, chosen: null };
const CANDIDATES: RustToolchainCandidatesResponse = {
  // A linked toolchain can have any name.
  candidates: [{ name: "automatic", path: "/linked", version: "1.80.0" }],
  automatic: { status: "none", rustupPath: null, detail: null },
  chosen: null,
};

const originalClient = await import("@/api/rust-toolchain-client");
const setRustToolchainChoice = jest.fn(async () => STATUS);
mock.module("@/api/rust-toolchain-client", () => ({
  ...originalClient,
  getRustToolchainCandidates: async () => CANDIDATES,
  setRustToolchainChoice,
}));

let pick: (ids: string[]) => string = ([id]) => id ?? "";
const originalPalette = await import("@/store/command-palette");
mock.module("@/store/command-palette", () => ({
  ...originalPalette,
  requestQuickPick: async ({ items }: { items: Promise<Array<{ id: string }>> }) =>
    pick((await items).map(({ id }) => id)),
}));

const { rustToolchainLabel, rustToolchainShortName, selectRustToolchain } =
  await import("./rust-toolchain");

afterEach(() => setRustToolchainChoice.mockClear());

describe("selectRustToolchain", () => {
  test("a toolchain named like the automatic entry is still that toolchain", async () => {
    pick = (ids) => ids.at(-1) ?? "";
    await selectRustToolchain("/wt");
    expect(setRustToolchainChoice.mock.calls).toEqual([
      [{ worktreePath: "/wt", toolchain: "automatic" }],
    ] as never);
  });

  test("the automatic entry clears the choice", async () => {
    pick = (ids) => ids[0] ?? "";
    await selectRustToolchain("/wt");
    expect(setRustToolchainChoice.mock.calls).toEqual([
      [{ worktreePath: "/wt", toolchain: null }],
    ] as never);
  });
});

describe("labels", () => {
  test("names lose their host triple, and a version-named toolchain does not repeat it", () => {
    expect(rustToolchainShortName("stable-aarch64-apple-darwin")).toBe("stable");
    expect(rustToolchainShortName("nightly-2026-01-01-x86_64-unknown-linux-gnu")).toBe(
      "nightly-2026-01-01",
    );
    expect(rustToolchainShortName("/opt/my-toolchain")).toBe("my-toolchain");
    const active = {
      status: "active",
      source: "default",
      rustcPath: "/x/bin/rustc",
      sysroot: "/x",
      toolchainFile: null,
      tools: { cargo: null, rustfmt: null, cargoClippy: null, rustAnalyzer: null, rustSrc: false },
    } as const;
    expect(
      rustToolchainLabel({ ...active, name: "1.90.0-aarch64-apple-darwin", version: "1.90.0" }),
    ).toBe("Rust 1.90.0");
    expect(rustToolchainLabel({ ...active, name: null, version: "1.88.0" })).toBe("Rust 1.88.0");
  });
});
