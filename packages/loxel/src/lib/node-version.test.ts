import { expect, test } from "bun:test";

import { isToolchainChangedMessage, isToolchainSelectAction } from "@/api/toolchain-status-model";
import { ACTIONS } from "@/store/keybindings/action-registry";
import { LOXEL_DEFAULT_TEMPLATE } from "@/store/keybindings/keybinding-schema";

import { nodeInstallLabel, nodeSourceDescription } from "./node-version";

const install = { nodePath: "/x/bin/node", version: "22.11.0", manager: "nvm" } as const;

test("labels say the version and where it came from", () => {
  expect(nodeInstallLabel(install)).toBe("Node 22.11.0 (nvm)");
  expect(nodeInstallLabel({ ...install, manager: null })).toBe("Node 22.11.0 (PATH)");
  expect(nodeInstallLabel({ ...install, manager: null, version: null })).toBe("Node (PATH)");
});

test("tooltips say how it was chosen", () => {
  expect(nodeSourceDescription({ ...install, source: "pin" }, ".nvmrc")).toBe("Pinned by .nvmrc");
  expect(nodeSourceDescription({ ...install, source: "override" }, null)).toBe(
    "Chosen for this worktree",
  );
});

test("the toolchain is registered, with its command unbound", () => {
  expect(isToolchainChangedMessage({ type: "node_env_changed" })).toBe(true);
  expect(isToolchainSelectAction("node.selectVersion")).toBe(true);
  expect(ACTIONS.find(({ id }) => id === "node.selectVersion")?.label).toBe("Node: Select Version");
  expect(LOXEL_DEFAULT_TEMPLATE["node.selectVersion"]).toEqual([]);
});
