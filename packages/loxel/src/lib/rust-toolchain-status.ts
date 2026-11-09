import { rustToolchain } from "@/api/rust-toolchain-model";
import { RustToolchainStatus } from "@/components/panels/RustToolchainStatus";

import { selectRustToolchain } from "./rust-toolchain";
import type { ToolchainStatusItem } from "./toolchain-status-item";

export const rustToolchainStatusItem: ToolchainStatusItem = {
  toolchain: rustToolchain,
  StatusItem: RustToolchainStatus,
  select: selectRustToolchain,
};
