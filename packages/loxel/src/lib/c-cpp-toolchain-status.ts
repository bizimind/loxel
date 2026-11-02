import { cCppToolchain } from "@/api/c-cpp-compile-database-model";
import { CompileDatabaseStatusItem } from "@/components/panels/CompileDatabaseStatus";

import { selectCompileDatabase } from "./c-cpp-compile-database";
import type { ToolchainStatusItem } from "./toolchain-status-item";

export const cCppToolchainStatusItem: ToolchainStatusItem = {
  toolchain: cCppToolchain,
  StatusItem: CompileDatabaseStatusItem,
  select: selectCompileDatabase,
};
