import { describe, expect, test } from "bun:test";

import type { RunningTerminal } from "@/api/running-terminals-model";

import { terminalRestartConfirmation, terminalRestartWarning } from "./update-terminal-restart";

function terminal(overrides: Partial<RunningTerminal> = {}): RunningTerminal {
  return {
    id: crypto.randomUUID(),
    worktreePath: "/projects/shop/feat-cart",
    cwd: "/projects/shop/feat-cart",
    otherHostBuild: false,
    ...overrides,
  };
}

describe("terminalRestartWarning", () => {
  test("says how many terminals the update restarts, or may restart", () => {
    expect(terminalRestartWarning(true, 3)).toBe("This update restarts 3 terminals");
    expect(terminalRestartWarning(true, 1)).toBe("This update restarts 1 terminal");
    expect(terminalRestartWarning("unknown", 2)).toBe("This update may restart 2 terminals");
  });

  test("says nothing for an update that keeps them, or with no terminal running", () => {
    expect(terminalRestartWarning(false, 3)).toBeNull();
    expect(terminalRestartWarning(true, 0)).toBeNull();
  });
});

describe("terminalRestartConfirmation", () => {
  test("lists the terminals with a program running, and counts the rest", () => {
    const busy = terminal({ program: "claude" });
    const confirmation = terminalRestartConfirmation("1.2.0", true, [
      busy,
      terminal({ program: null }),
      // Its terminal host cannot tell (no foregroundProcess capability): counted only.
      terminal(),
    ]);
    expect(confirmation).toEqual({
      title: "This update restarts 3 terminals",
      message:
        "Version 1.2.0 cannot take over the terminals running now, so installing it ends all 3.",
      busy: [{ id: busy.id, program: "claude", worktree: "feat-cart" }],
    });
  });

  test("falls back to the count when no terminal host can tell what runs", () => {
    const confirmation = terminalRestartConfirmation("1.2.0", "unknown", [terminal()]);
    expect(confirmation).toEqual({
      title: "This update may restart 1 terminal",
      message:
        "Version 1.2.0 does not say whether it can take over the terminals running now. If it cannot, installing it ends it.",
      busy: [],
    });
  });

  test("asks nothing for an update that keeps the terminals, or with none running", () => {
    expect(terminalRestartConfirmation("1.2.0", false, [terminal()])).toBeNull();
    expect(terminalRestartConfirmation("1.2.0", true, [])).toBeNull();
  });
});
