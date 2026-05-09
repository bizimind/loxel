#!/usr/bin/env bun
/**
 * Agentic editor for git interactive rebase
 *
 * Used as GIT_SEQUENCE_EDITOR. Receives the todo file path as argument,
 * prints instructions, and waits for SIGTERM to continue.
 */

import { dirname } from "path";

import { writePidfile, removePidfile, sleep } from "../utils/process.ts";

const todoFile = process.argv[2];

if (!todoFile) {
  console.error("ERROR: No todo file path provided");
  process.exit(1);
}

// Check if file exists
const file = Bun.file(todoFile);
if (!(await file.exists())) {
  console.error(`ERROR: Todo file does not exist: ${todoFile}`);
  process.exit(1);
}

// Create pidfile
const stateDir = dirname(todoFile);
const pidfile = `${stateDir}/agentic-editor.pid`;
await writePidfile(pidfile);

// Print instructions
console.log("");
console.log("Using agent-compatible rebase editor.");
console.log("");
console.log(`Edit the rebase TODO file at: ${todoFile}`);
console.log("");
console.log(`When ready, run: continue-rebase ${process.pid}`);
console.log("To abort, run: git rebase --abort");
console.log("");

// Track exit state
let exitCode = 0;
let signalReceived = false;

// Handle signals
process.on("SIGTERM", () => {
  signalReceived = true;
  exitCode = 0;
});

process.on("SIGINT", () => {
  signalReceived = true;
  exitCode = 1;
});

/**
 * Recursive polling - check for signal and file existence
 */
async function pollUntilExit(): Promise<void> {
  if (signalReceived) {
    return;
  }

  await sleep(5000);

  // Check if todo file still exists (rebase might have been aborted)
  if (!(await file.exists())) {
    exitCode = 1;
    return;
  }

  return pollUntilExit();
}

// Wait for exit condition
await pollUntilExit();

// Cleanup and exit
await removePidfile(pidfile);
process.exit(exitCode);
