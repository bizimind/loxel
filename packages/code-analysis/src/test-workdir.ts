import { chmod, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The tmpdir is realpath'd because the CLI realpaths its workdir too.
export async function withWorkDir<T>(
  files: Record<string, string>,
  fn: (workDir: string) => Promise<T>,
): Promise<T> {
  const workDir = await realpath(await mkdtemp(join(tmpdir(), "code-analysis-test-")));
  try {
    await Promise.all(
      Object.entries(files).map(([name, content]) => Bun.write(join(workDir, name), content)),
    );
    return await fn(workDir);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

export async function git(workDir: string, ...args: string[]): Promise<void> {
  const proc = Bun.spawn(["git", ...args], { cwd: workDir, stdout: "ignore", stderr: "pipe" });
  const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  if (exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${stderr}`);
}

/** Installs a shell script as a tool of the project at dir, standing in for the real one or wrapping it. */
export async function installFakeBin(dir: string, name: string, script: string): Promise<string> {
  const bin = join(dir, "node_modules", ".bin", name);
  await Bun.write(bin, `#!/bin/sh\n${script}\n`);
  await chmod(bin, 0o755);
  return bin;
}
