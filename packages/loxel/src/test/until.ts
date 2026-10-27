/**
 * Wait until `condition` holds, checking every 10 ms, for state a test cannot be notified of (a
 * shell's output, a file a command writes). Fails after `timeoutMs`.
 */
export async function until(condition: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for condition");
    await Bun.sleep(10);
  }
}
