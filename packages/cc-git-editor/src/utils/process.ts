/**
 * Process utilities
 *
 * Signal handling and pidfile management.
 */

import { unlink } from "fs/promises";

/**
 * Write a pidfile with the current process ID.
 */
export async function writePidfile(path: string): Promise<void> {
  await Bun.write(path, String(process.pid));
}

/**
 * Remove a pidfile.
 */
export async function removePidfile(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch {
    // Ignore errors (file may not exist)
  }
}

/**
 * Sleep for a given number of milliseconds.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Check if a process is running by PID.
 */
export function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Get process command line by PID (for verification).
 */
export async function getProcessCommand(pid: number): Promise<string | null> {
  try {
    const result = await Bun.$`ps -p ${pid} -o args=`.quiet().nothrow();
    if (result.exitCode === 0) {
      return result.stdout.toString().trim();
    }
    return null;
  } catch {
    return null;
  }
}
