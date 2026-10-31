import { javaToolchain } from "@/api/java-env-model";
import { JavaRuntimeStatus } from "@/components/panels/JavaRuntimeStatus";

import { selectJavaRuntime } from "./java-runtime";
import type { ToolchainStatusItem } from "./toolchain-status-item";

export const javaToolchainStatusItem: ToolchainStatusItem = {
  toolchain: javaToolchain,
  StatusItem: JavaRuntimeStatus,
  select: selectJavaRuntime,
};
