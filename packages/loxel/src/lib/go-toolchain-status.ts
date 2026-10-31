import { goToolchain } from "@/api/go-env-model";
import { GoToolchainStatus } from "@/components/panels/GoToolchainStatus";

import { refreshGoToolchain } from "./go-toolchain";
import type { ToolchainStatusItem } from "./toolchain-status-item";

export const goToolchainStatusItem: ToolchainStatusItem = {
  toolchain: goToolchain,
  StatusItem: GoToolchainStatus,
  select: refreshGoToolchain,
};
