import { csharpToolchain } from "@/api/csharp-env-model";
import { CSharpStatus } from "@/components/panels/CSharpStatus";

import { selectCSharpSolution } from "./csharp-solution";
import type { ToolchainStatusItem } from "./toolchain-status-item";

export const csharpToolchainStatusItem: ToolchainStatusItem = {
  toolchain: csharpToolchain,
  StatusItem: CSharpStatus,
  select: selectCSharpSolution,
};
