import { afterAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";

import { createNoopLogger } from "@bizimind/logger";

import { InProcessTerminalHost } from "@/terminal-host";
import { until } from "@/test/until";

// The tests choose where versions live; the machine's own manager settings must not apply.
for (const name of [
  "FNM_DIR",
  "VOLTA_HOME",
  "ASDF_DATA_DIR",
  "MISE_DATA_DIR",
  "MISE_INSTALLS_DIR",
  "XDG_DATA_HOME",
  "N_CACHE_PREFIX",
]) {
  delete process.env[name];
}
const root = realpathSync(mkdtempSync(join(tmpdir(), "node-toolchain-env-")));
// Overrides live in the store database; keep the tests' state out of the real one.
process.env.LOXEL_STATE_DIR = join(root, "state");
process.env.HOME = join(root, "home");
process.env.NVM_DIR = join(root, "nvm");
process.env.N_PREFIX = join(root, "n");
const originalPath = process.env.PATH ?? "";
// A `node` on PATH that says what it is, so a pin that matches nothing falls back to it.
const pathDir = join(root, "path-bin");
process.env.PATH = [pathDir, originalPath].join(delimiter);
const { resolveNodeEnv } = await import("./node-env");
const { setNodeOverride } = await import("./node-override-store");
const { nodeToolchainEnv } = await import("./node-toolchain-env");
const { TerminalManager } = await import("./terminal-manager");
const { commitToolchainEnvChange } = await import("./toolchain-env-contributor");

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function writeNode(filePath: string, output: string): string {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `#!/bin/sh\necho ${output}\n`);
  chmodSync(filePath, 0o755);
  return filePath;
}

writeNode(join(pathDir, "node"), "v18.0.0");
const pinnedBin = dirname(writeNode(join(root, "nvm/versions/node/v22.1.0/bin/node"), "v22.1.0"));
const otherBin = dirname(writeNode(join(root, "nvm/versions/node/v20.5.0/bin/node"), "v20.5.0"));

function git(cwd: string, ...args: string[]): void {
  const result = Bun.spawnSync(["git", "-C", cwd, ...args], { stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
}

let worktrees = 0;

function makeWorktree(pin?: string): string {
  const wt = join(root, `wt-${++worktrees}`);
  mkdirSync(wt, { recursive: true });
  git(wt, "init", "-q");
  if (pin) writeFileSync(join(wt, ".nvmrc"), pin);
  return wt;
}

/** What a new shell's resolution makes of `env`. */
async function applied(wt: string, env: Record<string, string | undefined> = {}) {
  const change = await nodeToolchainEnv.resolveForTerminal(wt);
  await change?.(env, "/bin/sh");
  return { change, env };
}

describe("nodeToolchainEnv", () => {
  test("a pinned Node's bin goes first on PATH, moved rather than duplicated", async () => {
    const { env } = await applied(makeWorktree("22"), {
      PATH: ["/usr/bin", pinnedBin, "/bin"].join(delimiter),
      NODE_OPTIONS: "--kept",
    });
    expect(env).toEqual({
      PATH: [pinnedBin, "/usr/bin", "/bin"].join(delimiter),
      NODE_OPTIONS: "--kept",
    });
  });

  test("a chosen Node's bin goes first, over the pin", async () => {
    const wt = makeWorktree("22");
    setNodeOverride(wt, join(otherBin, "node"));
    const { env } = await applied(wt, { PATH: "/usr/bin" });
    expect(env.PATH).toBe([otherBin, "/usr/bin"].join(delimiter));
  });

  test.each([
    ["no pin", undefined],
    ["a pin nothing installed satisfies", "16"],
  ])("changes nothing for the PATH node with %s", async (_name, pin) => {
    const { change } = await applied(makeWorktree(pin));
    expect(change).toBeNull();
  });

  test("changes nothing when the PATH node itself is the choice", async () => {
    const wt = makeWorktree("22");
    setNodeOverride(wt, join(pathDir, "node"));
    expect((await resolveNodeEnv(wt)).env?.source).toBe("override");
    const { change } = await applied(wt);
    expect(change).toBeNull();
  });

  test("changes nothing for a bin holding a file git tracks", async () => {
    const wt = makeWorktree("23");
    // Not `node` itself, which the resolver checks: only what sits beside it is tracked.
    const bin = join(wt, "nvm/versions/node/v23.0.0/bin");
    writeNode(join(bin, "node"), "v23.0.0");
    writeFileSync(join(bin, "git"), "#!/bin/sh\n");
    git(wt, "add", join(bin, "git"));
    process.env.NVM_DIR = join(wt, "nvm");
    try {
      expect((await resolveNodeEnv(wt)).env?.source).toBe("pin");
      const { change } = await applied(wt);
      expect(change).toBeNull();
    } finally {
      process.env.NVM_DIR = join(root, "nvm");
    }
  });

  test("a new shell's answer runs no node", async () => {
    const canaryDir = join(root, "canary-bin");
    const marker = join(canaryDir, "ran");
    const canary = join(canaryDir, "node");
    mkdirSync(canaryDir);
    writeFileSync(canary, `#!/bin/sh\ntouch "${marker}"\necho v18.0.0\n`);
    chmodSync(canary, 0o755);
    const originalWithPath = process.env.PATH;
    process.env.PATH = [canaryDir, originalWithPath].join(delimiter);
    try {
      expect(await nodeToolchainEnv.resolveForTerminal(makeWorktree())).toBeNull();
      const chosen = makeWorktree();
      setNodeOverride(chosen, canary);
      expect(await nodeToolchainEnv.resolveForTerminal(chosen)).toBeNull();
      expect(existsSync(marker)).toBe(false);
    } finally {
      process.env.PATH = originalWithPath;
    }
  });

  test("the shared PATH check refuses a bin the shell would interpret", async () => {
    const nvmDir = join(root, "nvm-$quoted");
    writeNode(join(nvmDir, "versions/node/v24.0.0/bin/node"), "v24.0.0");
    const wt = makeWorktree("24");
    process.env.NVM_DIR = nvmDir;
    try {
      const { change, env: changed } = await applied(wt, { PATH: "/usr/bin" });
      expect(change).not.toBeNull();
      const env = { PATH: "/usr/bin" };
      commitToolchainEnvChange(env, changed);
      expect(env.PATH).toBe("/usr/bin");
    } finally {
      process.env.NVM_DIR = join(root, "nvm");
    }
  });

  test("a new shell gets the pinned Node's bin on PATH", async () => {
    const originalShell = process.env.SHELL;
    process.env.SHELL = "/bin/sh";
    const wt = makeWorktree("22");
    const manager = new TerminalManager(new InProcessTerminalHost({ log: createNoopLogger() }), {
      isSequenceEnabled: () => false,
      onNotification: () => {},
      onExit: () => {},
      toolchainEnvs: [nodeToolchainEnv],
    });
    let output = "";
    const decoder = new TextDecoder();
    try {
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
          cwd: wt,
          // Only presence: a login shell's startup can reorder PATH, which the docs describe.
          command: `case ":$PATH:" in *:${pinnedBin}:*) echo node-on-$((1+1));; esac`,
        },
      );
      await until(() => output.includes("node-on-2"));
    } finally {
      manager.destroyAll();
      process.env.SHELL = originalShell;
    }
  });
});
