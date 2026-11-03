import { describe, expect, test } from "bun:test";

import { killProcessTrees } from "./kill-process-tree";

/** Neither gone, nor killed and only waiting to be collected. */
function isRunning(pid: number): boolean {
  const state = Bun.spawnSync(["ps", "-o", "stat=", "-p", String(pid)]).stdout.toString();
  return state.trim() !== "" && !state.startsWith("Z");
}

async function untilGone(pid: number): Promise<void> {
  while (isRunning(pid)) await Bun.sleep(20);
}

/** The pids a command prints, once it has printed `count` of them. */
async function pidsPrinted(proc: Bun.Subprocess<"ignore", "pipe">, count: number) {
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (text.trim().split(/\s+/).length < count || !text.endsWith("\n")) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value);
  }
  return text.trim().split(/\s+/).map(Number);
}

const spawn = (script: string) =>
  Bun.spawn(["/bin/sh", "-c", script], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });

describe("killProcessTrees", () => {
  test("ends every root and what is below it, in another process group too", async () => {
    const first = spawn(`/bin/sleep 1000 & echo $!; wait`);
    const second = spawn(`(set -m; /bin/sleep 1000 & echo $!; wait) & wait`);
    const [firstChild = 0] = await pidsPrinted(first, 1);
    const [secondChild = 0] = await pidsPrinted(second, 1);
    killProcessTrees([first.pid, second.pid]);
    await Promise.all([first.exited, second.exited, untilGone(firstChild), untilGone(secondChild)]);
    expect(first.signalCode).toBe("SIGKILL");
    expect(second.signalCode).toBe("SIGKILL");
  });

  test("ends the tree of a root whose parent has gone", async () => {
    const outer = spawn(`/bin/sh -c '/bin/sleep 1000 & echo $$; echo $!; wait' & exit 0`);
    const [root = 0, child = 0] = await pidsPrinted(outer, 2);
    await outer.exited;
    expect(isRunning(child)).toBe(true);
    killProcessTrees([root]);
    await Promise.all([untilGone(root), untilGone(child)]);
  });

  test("leaves everything else alone, and takes a root that has already ended", async () => {
    const bystander = spawn(`/bin/sleep 1000`);
    const ended = Bun.spawn(["/usr/bin/true"]);
    await ended.exited;
    killProcessTrees([ended.pid]);
    expect(isRunning(bystander.pid)).toBe(true);
    bystander.kill("SIGKILL");
    await bystander.exited;
  });
});
