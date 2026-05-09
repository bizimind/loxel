#!/usr/bin/env bun
/**
 * Signal the sleeping rebase editor to continue
 *
 * Verifies the process is actually an agentic-editor before sending SIGTERM.
 */

import { isProcessRunning, getProcessCommand } from "../utils/process.ts";

const pid = parseInt(process.argv[2] ?? "", 10);

if (!pid || isNaN(pid)) {
  console.error("Usage: continue-rebase <pid>");
  console.error("");
  console.error("Signals the rebase editor to close and continue with the rebase.");
  console.error("The PID is printed when you start an interactive rebase in agent mode.");
  process.exit(1);
}

// Check if process is running
if (!isProcessRunning(pid)) {
  console.error(`ERROR: Process ${pid} is not running.`);
  console.error("The rebase editor may have already exited or been aborted.");
  process.exit(1);
}

// Verify this is actually our agentic-editor process
const procCmd = await getProcessCommand(pid);
if (!procCmd || !procCmd.includes("agentic-editor")) {
  console.error(`ERROR: Process ${pid} is not an agentic-editor process.`);
  console.error(`Process command: ${procCmd || "unknown"}`);
  console.error("Refusing to send signal to unknown process.");
  process.exit(1);
}

console.log(`Closing rebase editor (PID ${pid}) and continuing rebase...`);

// Send SIGTERM to the editor
process.kill(pid, "SIGTERM");

console.log("Done. The rebase will now proceed with your edited todo file.");
console.log("Watch for conflicts or check git status for progress.");
