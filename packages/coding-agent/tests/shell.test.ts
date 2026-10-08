import { describe, expect, test } from "bun:test";

import {
  killProcessGroup,
  SHELL_PROCESS_GROUP_SPAWN_OPTIONS,
  terminateProcessGroup,
} from "../src/utils/shell.ts";

describe("killProcessGroup", () => {
  test("signals the whole group when the process is a group leader", async () => {
    const proc = Bun.spawn(["sh", "-c", "sleep 30 & wait"], {
      ...SHELL_PROCESS_GROUP_SPAWN_OPTIONS,
      stdout: "ignore",
      stderr: "ignore",
    });
    killProcessGroup(proc, "SIGTERM");
    expect(await proc.exited).not.toBe(0);
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
