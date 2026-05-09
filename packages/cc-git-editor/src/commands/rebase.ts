/**
 * Handle git rebase -i in agent mode
 *
 * Runs rebase in background with our agentic editor,
 * which prints the todo file path and waits for signal to continue.
 */

import { dirname } from "path";

import { findRealGit } from "../utils/git.ts";

/**
 * Handle interactive rebase in agent mode.
 *
 * Spawns git rebase with GIT_SEQUENCE_EDITOR pointing to our agentic-editor,
 * which will print instructions and wait for signal.
 */
export async function handleRebase(args: string[]): Promise<void> {
  const realGit = findRealGit();

  // Find our agentic-editor binary (same directory as this binary)
  // Use process.execPath for compiled binaries (process.argv[1] gives internal bun path)
  const binDir = dirname(process.execPath);
  const agenticEditor = `${binDir}/agentic-editor`;

  console.log("Starting interactive rebase in agent mode...");
  console.log("");

  // Spawn git rebase with our editor, detached
  const proc = Bun.spawn([realGit, ...args], {
    env: { ...process.env, GIT_SEQUENCE_EDITOR: agenticEditor },
    stdio: ["inherit", "inherit", "inherit"],
  });

  // Don't wait for the process - let it run in background
  // The agentic-editor will print instructions
  proc.unref();

  // Give it time to start and print output
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 500);
  });

  process.exit(0);
}
