import { describe, expect, test } from "bun:test";

import { ACTIONS } from "@/store/keybindings/action-registry";
import { LOXEL_DEFAULT_TEMPLATE } from "@/store/keybindings/keybinding-schema";

import { isToolchainChangedMessage, isToolchainSelectAction } from "./toolchain-status-model";

describe("registered toolchains", () => {
  test("recognize their changed messages and select actions only", () => {
    expect(isToolchainChangedMessage({ type: "python_env_changed" })).toBe(true);
    expect(isToolchainChangedMessage({ type: "detached_files_changed" })).toBe(false);
    expect(isToolchainSelectAction("python.selectInterpreter")).toBe(true);
    expect(isToolchainSelectAction("language.restartServers")).toBe(false);
  });

  test("register their select action, enabled by worktree and unbound by default", () => {
    const action = ACTIONS.find(({ id }) => id === "python.selectInterpreter");
    expect(action?.label).toBe("Python: Select Interpreter");
    expect(action?.category).toBe("language");
    expect(LOXEL_DEFAULT_TEMPLATE["python.selectInterpreter"]).toEqual([]);
  });
});
