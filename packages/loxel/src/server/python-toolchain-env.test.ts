import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createNoopLogger } from "@bizimind/logger";

import { InProcessTerminalHost } from "@/terminal-host";
import { until } from "@/test/until";

// Interpreter overrides live in the store database; keep the tests' state out of the real one.
const root = await realpath(await mkdtemp(join(tmpdir(), "loxel-python-toolchain-env-")));
process.env.LOXEL_STATE_DIR = join(root, "state");
// The shared resolution reads the process's environment; keep the developer's out of it.
for (const name of ["VIRTUAL_ENV", "CONDA_PREFIX", "UV_PROJECT_ENVIRONMENT"])
  delete process.env[name];
const { TERMINAL_PYTHON_ENV_RESTRICTION, pythonToolchainEnv } =
  await import("./python-toolchain-env");
const { getRepoTrustStatus, setRepoTrusted } = await import("./repo-trust");
const { TerminalManager } = await import("./terminal-manager");

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("pythonToolchainEnv", () => {
  test("only the terminal setting turns it off", () => {
    expect(pythonToolchainEnv.enabledInTerminal?.({ activatePythonEnv: false })).toBe(false);
    expect(pythonToolchainEnv.enabledInTerminal?.({ activatePythonEnv: true })).toBe(true);
    expect(pythonToolchainEnv.enabledInTerminal?.({})).toBe(true);
  });

  test("a new shell gets the worktree's environment on PATH once the repository is trusted", async () => {
    const originalShell = process.env.SHELL;
    process.env.SHELL = "/bin/sh";
    const worktree = join(root, "wt");
    await mkdir(join(worktree, ".venv", "bin"), { recursive: true });
    Bun.spawnSync(["git", "init", "-q", worktree]);
    await writeFile(join(worktree, ".venv", "bin", "python"), "#!/bin/sh\n", { mode: 0o755 });
    await writeFile(join(worktree, ".venv", "pyvenv.cfg"), "home = /usr/bin\n");
    const manager = new TerminalManager(new InProcessTerminalHost({ log: createNoopLogger() }), {
      isSequenceEnabled: () => false,
      onNotification: () => {},
      onExit: () => {},
      toolchainEnvs: [pythonToolchainEnv],
    });
    /** Whether a new shell has the environment on PATH. */
    const activated = async (): Promise<boolean> => {
      let output = "";
      const decoder = new TextDecoder();
      await manager.attach(
        crypto.randomUUID(),
        {
          sendState: () => {},
          sendOutput: ({ data }) => {
            output += decoder.decode(data);
          },
          sendExit: () => {},
        },
        {
          cols: 80,
          rows: 24,
          cwd: worktree,
          // Only zsh keeps the entry first (macOS /etc/profile reorders PATH for sh), so check presence.
          command: `case ":$PATH:" in *:${worktree}/.venv/bin:*) echo env-$((1+1))-on;; *) echo env-$((1+1))-off;; esac`,
        },
      );
      await until(() => /env-2-(on|off)/.test(output));
      return output.includes("env-2-on");
    };
    try {
      expect(await activated()).toBe(false);
      expect(getRepoTrustStatus(worktree).restrictions).toEqual([TERMINAL_PYTHON_ENV_RESTRICTION]);
      setRepoTrusted(worktree, true);
      expect(await activated()).toBe(true);
    } finally {
      manager.destroyAll();
      process.env.SHELL = originalShell;
    }
  });
});
