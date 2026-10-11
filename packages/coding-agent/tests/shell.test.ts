import { describe, expect, test } from "bun:test";

import {
  killProcessGroup,
  SHELL_PROCESS_GROUP_SPAWN_OPTIONS,
  terminateProcessGroup,
} from "../src/utils/shell.ts";

/** Polls until `pid` no longer exists (ESRCH) or the deadline passes. */
async function waitForProcessGone(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await Bun.sleep(20);
  }
  return false;
}

describe("killProcessGroup", () => {
  test("signals the whole group when the process is a group leader", async () => {
    // The leader exits non-zero whenever it is signalled at all, so the only evidence of
    // group semantics is the backgrounded grandchild dying. The shell prints the grandchild's
    // pid first, which also guarantees it exists before we signal.
    const proc = Bun.spawn(["sh", "-c", "sleep 30 & echo $!; wait"], {
      ...SHELL_PROCESS_GROUP_SPAWN_OPTIONS,
      stdout: "pipe",
      stderr: "ignore",
    });
    const reader = proc.stdout.getReader();
    const childPid = Number.parseInt(new TextDecoder().decode((await reader.read()).value), 10);
    expect(Number.isInteger(childPid) && childPid > 0).toBe(true);
    try {
      killProcessGroup(proc, "SIGTERM");
      expect(await proc.exited).not.toBe(0);
      expect(await waitForProcessGone(childPid, 2000)).toBe(true);
    } finally {
      // Never leave a stray `sleep` behind if the assertion fails.
      try {
        process.kill(childPid, "SIGKILL");
      } catch {
        // Already gone (ESRCH): the expected outcome.
      }
    }
  });

  test("falls back to signalling the process itself when it is not a group leader", async () => {
    // Without `detached` the child inherits our pgid, so `kill(-pid)` targets a group that
    // does not exist (ESRCH) and the fallback must still terminate the child.
    const proc = Bun.spawn(["sleep", "30"], { stdout: "ignore", stderr: "ignore" });
    killProcessGroup(proc, "SIGTERM");
    const exited = await Promise.race([proc.exited, Bun.sleep(2000).then(() => "timeout")]);
    expect(exited).not.toBe("timeout");
    expect(proc.signalCode).toBe("SIGTERM");
  });

  test("is a no-op for an already-exited process", async () => {
    const proc = Bun.spawn(["true"], { stdout: "ignore", stderr: "ignore" });
    await proc.exited;
    expect(() => killProcessGroup(proc, "SIGKILL")).not.toThrow();
  });
});

describe("terminateProcessGroup", () => {
  test("escalates to SIGKILL when SIGTERM is ignored", async () => {
    // The leader ignores SIGTERM (and `sleep` inherits the ignored disposition), so only the
    // escalation can end the group. Wait for the shell to confirm the trap is installed
    // before signalling, otherwise SIGTERM can land first and kill it outright.
    const proc = Bun.spawn(["sh", "-c", "trap '' TERM; echo ready; sleep 30; sleep 30"], {
      ...SHELL_PROCESS_GROUP_SPAWN_OPTIONS,
      stdout: "pipe",
      stderr: "ignore",
    });
    const reader = proc.stdout.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("ready");
    terminateProcessGroup(proc);
    const exited = await Promise.race([proc.exited, Bun.sleep(4000).then(() => "timeout")]);
    expect(exited).not.toBe("timeout");
    expect(proc.signalCode).toBe("SIGKILL");
  });
});
