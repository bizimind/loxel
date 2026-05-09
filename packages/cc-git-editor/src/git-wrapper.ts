/**
 * Git wrapper for agent-friendly interactive commands
 *
 * Intercepts specific git commands in agent mode and handles them
 * in a non-blocking way. All other commands pass through to real git.
 */

import { handleAddPatch } from "./commands/add-patch.ts";
import { handleRebase } from "./commands/rebase.ts";
import { isAgentMode } from "./utils/agent-detection.ts";
import { execRealGit } from "./utils/git.ts";

const args = process.argv.slice(2);

/**
 * Check if args represent an interactive rebase command.
 */
function isInteractiveRebase(args: string[]): boolean {
  let foundRebase = false;
  let foundInteractive = false;

  for (const arg of args) {
    if (arg === "rebase") foundRebase = true;
    if (arg === "-i" || arg === "--interactive" || arg.startsWith("--interactive=")) {
      foundInteractive = true;
    }
  }

  return foundRebase && foundInteractive;
}

/**
 * Check if args represent a git add -p command.
 */
function isAddPatch(args: string[]): boolean {
  let foundAdd = false;
  let foundPatch = false;

  for (const arg of args) {
    if (arg === "add") foundAdd = true;
    if (arg === "-p" || arg === "--patch") foundPatch = true;
  }

  return foundAdd && foundPatch;
}

async function main() {
  // In non-agent mode, always pass through to real git
  if (!isAgentMode()) {
    execRealGit(args);
  }

  // Handle specific commands in agent mode
  if (isInteractiveRebase(args)) {
    await handleRebase(args);
  } else if (isAddPatch(args)) {
    await handleAddPatch(args);
  } else {
    // All other commands pass through
    execRealGit(args);
  }
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
