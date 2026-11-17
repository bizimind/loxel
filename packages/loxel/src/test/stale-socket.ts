/** A socket file no process listens on at `path`: what a server killed with SIGKILL leaves. */
export async function leaveStaleSocket(path: string): Promise<void> {
  const child = Bun.spawn(
    [
      process.execPath,
      "-e",
      `Bun.serve({ unix: ${JSON.stringify(path)}, fetch: () => new Response("") }); console.log("ready")`,
    ],
    { stdout: "pipe", stderr: "inherit" },
  );
  // The child prints once it listens.
  const reader = child.stdout.getReader();
  await reader.read();
  reader.releaseLock();
  child.kill("SIGKILL");
  await child.exited;
}
