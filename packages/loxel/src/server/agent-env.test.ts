import { afterAll, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";

import type { PythonEnv } from "@/api/python-env-model";
import { until } from "@/test/until";

import type { EnvChange, ToolchainEnvContributor } from "./toolchain-env-contributor";

// Interpreter overrides live in the store database; keep the tests' state out of the real one.
const root = await realpath(await mkdtemp(join(tmpdir(), "loxel-agent-env-")));
process.env.LOXEL_STATE_DIR = join(root, "state");
// The shared resolution reads the process's environment; keep the developer's out of it.
for (const name of ["VIRTUAL_ENV", "CONDA_PREFIX", "UV_PROJECT_ENVIRONMENT"])
  delete process.env[name];
const { AgentEnv, buildAgentEnv } = await import("./agent-env");
const { pythonAgentEnvChange } = await import("./python-toolchain-env");
const { refreshPythonEnv, subscribePythonEnv } = await import("./python-env");
const { setPythonOverride } = await import("./python-override-store");

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): void {
  const result = Bun.spawnSync(["git", "-C", cwd, ...args], { stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
}

let worktrees = 0;

/** An empty git worktree. */
async function makeWorktree(): Promise<string> {
  const wt = join(root, `wt-${++worktrees}`);
  await mkdir(wt, { recursive: true });
  git(wt, "init", "-q");
  return wt;
}

/** A venv-shaped directory: `pyvenv.cfg` plus an executable `bin/python`. */
async function makeVenv(dir: string): Promise<PythonEnv> {
  const pythonPath = join(dir, "bin", "python");
  await mkdir(dirname(pythonPath), { recursive: true });
  await writeFile(join(dir, "pyvenv.cfg"), "home = /usr/bin\n");
  await writeFile(pythonPath, "#!/bin/sh\n");
  await chmod(pythonPath, 0o755);
  return { source: "venv", pythonPath, envPath: dir };
}

function firstOnPath(env: Record<string, string | undefined>): string | undefined {
  return env.PATH?.split(delimiter)[0];
}

/** Resolves on the shared resolution's next update for `wt` that finds `pythonPath`. */
function resolvedTo(wt: string, pythonPath: string): Promise<void> {
  return new Promise((resolve) => {
    const unsubscribe = subscribePythonEnv(wt, ({ env }) => {
      if (env?.pythonPath !== pythonPath) return;
      unsubscribe();
      resolve();
    });
  });
}

/** The agent env for `pythonEnv`, as an `AgentEnv` builds it once the resolution lands. */
async function agentEnvFor(
  wt: string,
  pythonEnv: PythonEnv,
): Promise<Record<string, string | undefined>> {
  return buildAgentEnv([await pythonAgentEnvChange(pythonEnv, wt)]);
}

describe("buildAgentEnv", () => {
  test("marks the env as an agent's and activates a venv, VIRTUAL_ENV included", async () => {
    const wt = await makeWorktree();
    const venv = await makeVenv(join(wt, ".venv"));
    const env = await agentEnvFor(wt, venv);
    expect(env.AI_AGENT).toBe("loxel");
    expect(firstOnPath(env)).toBe(join(wt, ".venv", "bin"));
    expect(env.VIRTUAL_ENV).toBe(join(wt, ".venv"));
  });

  test("puts a conda-style environment on PATH without claiming it is a venv", async () => {
    const wt = await makeWorktree();
    const pixiPath = join(wt, ".pixi", "envs", "default");
    await mkdir(join(pixiPath, "bin"), { recursive: true });
    const env = await agentEnvFor(wt, {
      source: "pixi",
      pythonPath: join(pixiPath, "bin", "python"),
      envPath: pixiPath,
    });
    expect(firstOnPath(env)).toBe(join(pixiPath, "bin"));
    expect(env.VIRTUAL_ENV).toBeUndefined();
  });

  test("leaves the env as it is without an environment or for one git tracks", async () => {
    const wt = await makeWorktree();
    const venv = await makeVenv(join(wt, ".venv"));
    const plain = buildAgentEnv([]);
    expect(plain.AI_AGENT).toBe("loxel");

    git(wt, "add", "-f", ".venv/bin/python");
    const tracked = await agentEnvFor(wt, venv);
    expect(tracked.PATH).toBe(plain.PATH);
    expect(tracked.VIRTUAL_ENV).toBeUndefined();
  });
});

describe("AgentEnv", () => {
  test("activates the worktree's resolution, then follows the interpreter override", async () => {
    const wt = await makeWorktree();
    await makeVenv(join(wt, ".venv"));
    const agentEnv = new AgentEnv(wt);
    try {
      await agentEnv.settled();
      expect(firstOnPath(agentEnv.get())).toBe(join(wt, ".venv", "bin"));
      expect(agentEnv.get().VIRTUAL_ENV).toBe(join(wt, ".venv"));

      const picked = await makeVenv(join(root, `picked-${worktrees}`));
      const repicked = resolvedTo(wt, picked.pythonPath);
      setPythonOverride(wt, picked.pythonPath);
      refreshPythonEnv(wt);
      await repicked;
      await agentEnv.settled();
      expect(firstOnPath(agentEnv.get())).toBe(dirname(picked.pythonPath));
      expect(agentEnv.get().VIRTUAL_ENV).toBe(picked.envPath ?? "");
    } finally {
      setPythonOverride(wt, null);
      agentEnv.dispose();
    }
  });

  test("picks up a venv created mid-session", async () => {
    const wt = await makeWorktree();
    const agentEnv = new AgentEnv(wt);
    try {
      await agentEnv.settled();
      expect(agentEnv.get().VIRTUAL_ENV).toBeUndefined();

      // What `uv sync` leaves behind; the worktree's watch notices it.
      const created = resolvedTo(wt, join(wt, ".venv", "bin", "python"));
      await makeVenv(join(wt, ".venv"));
      await created;
      await agentEnv.settled();
      expect(firstOnPath(agentEnv.get())).toBe(join(wt, ".venv", "bin"));
    } finally {
      agentEnv.dispose();
    }
  });

  test("builds the env at each call, so later login-shell variables apply", async () => {
    const wt = await makeWorktree();
    await makeVenv(join(wt, ".venv"));
    const agentEnv = new AgentEnv(wt);
    try {
      await agentEnv.settled();
      process.env.AGENT_ENV_TEST_LATE = "1";
      expect(agentEnv.get().AGENT_ENV_TEST_LATE).toBe("1");
      expect(firstOnPath(agentEnv.get())).toBe(join(wt, ".venv", "bin"));
    } finally {
      delete process.env.AGENT_ENV_TEST_LATE;
      agentEnv.dispose();
    }
  });

  test("applies every toolchain in list order, past one that fails", async () => {
    const wt = await makeWorktree();
    const contributor = (
      name: string,
      resolveForAgent: ToolchainEnvContributor["resolveForAgent"],
    ): ToolchainEnvContributor => ({
      name,
      resolveForTerminal: async () => null,
      resolveForAgent,
      subscribeForAgent: () => () => {},
    });
    let releaseSlow = () => {};
    const slow = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });
    const agentEnv = new AgentEnv(wt, [
      contributor("slow", async () => {
        await slow;
        return (env) => {
          env.TOOLCHAIN_ORDER = "slow";
        };
      }),
      contributor("failing", async () => {
        throw new Error("no toolchain");
      }),
      contributor("fast", async () => (env) => {
        env.TOOLCHAIN_ORDER = `${env.TOOLCHAIN_ORDER}, fast`;
      }),
    ]);
    releaseSlow();
    await agentEnv.settled();
    expect(agentEnv.get().TOOLCHAIN_ORDER).toBe("slow, fast");
    agentEnv.dispose();
  });

  test("a toolchain that never answers does not hold up another's updates", async () => {
    const wt = await makeWorktree();
    let hear: (resolve: () => Promise<EnvChange | null>) => void = () => {};
    let heard = () => {};
    const applied = new Promise<void>((resolve) => {
      heard = resolve;
    });
    const agentEnv = new AgentEnv(wt, [
      {
        name: "hanging",
        resolveForTerminal: async () => null,
        resolveForAgent: () => new Promise(() => {}),
        subscribeForAgent: () => () => {},
      },
      {
        name: "live",
        resolveForTerminal: async () => null,
        resolveForAgent: async () => null,
        subscribeForAgent: (_root, listener) => {
          hear = listener;
          return () => {};
        },
      },
    ]);
    hear(async () => {
      heard();
      return (env) => {
        env.TOOLCHAIN_LIVE = "yes";
      };
    });
    await applied;
    await until(() => agentEnv.get().TOOLCHAIN_LIVE === "yes");
    agentEnv.dispose();
  });

  test("a toolchain whose change or subscription throws costs the others nothing", async () => {
    const wt = await makeWorktree();
    const agentEnv = new AgentEnv(wt, [
      {
        name: "unsubscribable",
        resolveForTerminal: async () => null,
        resolveForAgent: async () => null,
        subscribeForAgent: () => {
          throw new Error("no subscription");
        },
      },
      {
        name: "throwing",
        resolveForTerminal: async () => null,
        resolveForAgent: async () => () => {
          throw new Error("no change");
        },
        subscribeForAgent: () => () => {},
      },
      {
        name: "fine",
        resolveForTerminal: async () => null,
        resolveForAgent: async () => (env) => {
          env.TOOLCHAIN_FINE = "yes";
        },
        subscribeForAgent: () => () => {},
      },
    ]);
    await agentEnv.settled();
    expect(agentEnv.get().TOOLCHAIN_FINE).toBe("yes");
    agentEnv.dispose();
  });

  test("gets no Python environment without a worktree", async () => {
    const agentEnv = new AgentEnv(".");
    await agentEnv.settled();
    expect(agentEnv.get().AI_AGENT).toBe("loxel");
    expect(agentEnv.get().VIRTUAL_ENV).toBeUndefined();
  });
});
