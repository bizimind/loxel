import { describe, expect, test } from "bun:test";

import type { RunningTerminal } from "@/api/running-terminals-model";

import { parseWhenQuitting, quitConfirmation } from "./quit-terminals";

function terminal(overrides: Partial<RunningTerminal> = {}): RunningTerminal {
  return {
    id: crypto.randomUUID(),
    worktreePath: "/projects/shop/feat-cart",
    cwd: "/projects/shop/feat-cart",
    otherHostBuild: false,
    program: null,
    ...overrides,
  };
}

describe("parseWhenQuitting", () => {
  test("keeps a known choice, and asks for a missing or unknown one", () => {
    expect(parseWhenQuitting("keep")).toBe("keep");
    expect(parseWhenQuitting("end")).toBe("end");
    expect(parseWhenQuitting(undefined)).toBe("ask");
    expect(parseWhenQuitting("hibernate")).toBe("ask");
  });
});

describe("quitConfirmation", () => {
  test("asks nothing when every shell is at its prompt, or none is running", () => {
    expect(quitConfirmation([terminal(), terminal()])).toBeNull();
    expect(quitConfirmation([])).toBeNull();
  });

  test("lists the terminals with a program running", () => {
    const agent = terminal({ program: "claude" });
    const devServer = terminal({ program: "pnpm", worktreePath: null });
    expect(quitConfirmation([agent, terminal(), devServer])).toEqual({
      title: "Programs are running in 2 terminals",
      message: "Quitting ends them, unless you keep them running until Loxel opens again.",
      busy: [
        { id: agent.id, program: "claude", worktree: "feat-cart" },
        { id: devServer.id, program: "pnpm", worktree: "Home" },
      ],
    });
    expect(quitConfirmation([agent])?.title).toBe("A program is running in a terminal");
  });

  test("counts the terminals whose terminal host cannot tell their program", () => {
    const agent = terminal({ program: "claude" });
    const older = terminal({ program: undefined });
    expect(quitConfirmation([agent, older])).toEqual({
      title: "A program is running in a terminal",
      message:
        "Quitting ends them, unless you keep them running until Loxel opens again. Loxel cannot tell whether 1 other terminal is running one.",
      busy: [{ id: agent.id, program: "claude", worktree: "feat-cart" }],
    });
    expect(quitConfirmation([older, terminal({ program: undefined })])).toEqual({
      title: "2 terminals may be running programs",
      message: "Quitting ends them, unless you keep them running until Loxel opens again.",
      busy: [],
    });
    expect(quitConfirmation([older])?.title).toBe("A terminal may be running a program");
  });

  test("asks without a list when the terminals could not be listed", () => {
    expect(quitConfirmation(null)).toEqual({
      title: "Terminals may be running programs",
      message:
        "Loxel could not list its terminals. Quitting ends them, unless you keep them running until Loxel opens again.",
      busy: [],
    });
  });
});
