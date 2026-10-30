import { getPythonEnv } from "@/api/python-env-client";
import { pythonToolchain } from "@/api/python-env-model";
import {
  pythonEnvSourceDescription,
  pythonInterpreterLabel,
  selectPythonInterpreter,
} from "@/lib/python-interpreter";
import { useActiveToolchainStatus } from "@/queries/use-toolchain-status";

import { ToolchainStatusButton } from "./ToolchainStatusButton";

/**
 * The Python interpreter of the active editor's worktree, shown while that editor holds a Python
 * file. Clicking it opens the interpreter picker for that worktree.
 */
export function PythonInterpreterStatus() {
  const active = useActiveToolchainStatus(pythonToolchain, getPythonEnv);

  if (!active) return null;

  const { wtPath, status } = active;
  const { env, overridePath } = status;
  const overrideUnusable = overridePath !== null && env?.source !== "override";
  const tooltip = [
    env
      ? `${env.pythonPath}\n${pythonEnvSourceDescription(env.source)}`
      : "No Python interpreter found",
    overrideUnusable &&
      `The chosen interpreter ${overridePath} cannot be used, so detection picked this one`,
    "Click to select an interpreter",
  ]
    .filter(Boolean)
    .join("\n");

  return (
    <ToolchainStatusButton
      label={env ? pythonInterpreterLabel(env, wtPath) : "Select Python Interpreter"}
      tooltip={tooltip}
      warning={!env || overrideUnusable}
      onSelect={() => void selectPythonInterpreter(wtPath)}
    />
  );
}
