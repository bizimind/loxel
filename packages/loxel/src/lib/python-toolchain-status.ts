import { pythonToolchain } from "@/api/python-env-model";
import { PythonInterpreterStatus } from "@/components/panels/PythonInterpreterStatus";

import { selectPythonInterpreter } from "./python-interpreter";
import type { ToolchainStatusItem } from "./toolchain-status-item";

export const pythonToolchainStatusItem: ToolchainStatusItem = {
  toolchain: pythonToolchain,
  StatusItem: PythonInterpreterStatus,
  select: selectPythonInterpreter,
};
