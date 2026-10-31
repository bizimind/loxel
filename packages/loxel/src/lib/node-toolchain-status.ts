import { nodeToolchain } from "@/api/node-env-model";
import { NodeVersionStatus } from "@/components/panels/NodeVersionStatus";

import { selectNodeVersion } from "./node-version";
import type { ToolchainStatusItem } from "./toolchain-status-item";

export const nodeToolchainStatusItem: ToolchainStatusItem = {
  toolchain: nodeToolchain,
  StatusItem: NodeVersionStatus,
  select: selectNodeVersion,
};
