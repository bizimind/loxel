import { afterAll, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { captureLoginShellEnv, LoginShellEnv } from "./shell-env";

const root = await mkdtemp(join(tmpdir(), "loxel-shell-env-"));
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

const BASE_ENV = { PATH: "/usr/bin:/bin", HOME: root };
let shellCount = 0;

/**
 * A stand-in login shell: runs `body` as its startup, then the command it is given (`-l -i -c
 * CMD`, so `$4`) with sh syntax, which the capture command is written to parse in every shell.
 */
async function fakeShell(body: string, runCommand = 'eval "$4"'): Promise<string> {
  const file = join(root, `shell-${++shellCount}`);
  await writeFile(file, `#!/bin/sh\n${body}\n${runCommand}\n`);
  await chmod(file, 0o755);
  return file;
}

const never = new AbortController().signal;

async function waitForPid(file: string): Promise<number> {
  for (;;) {
    const pid = await readFile(file, "utf8").catch(() => null);
    if (pid) return Number(pid);
    await Bun.sleep(10);
  }
}

async function waitUntilGone(pid: number): Promise<void> {
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await Bun.sleep(10);
  }
}

describe("captureLoginShellEnv", () => {
  test("reads the environment between the sentinels, skipping startup noise", async () => {
    const shell = await fakeShell(
      `echo "Welcome, have a nice day"
export PATH="/opt/tools/bin:$PATH" PYENV_ROOT="$HOME/.pyenv" MULTILINE="one
two=2"`,
    );
    const result = await captureLoginShellEnv(shell, BASE_ENV, never);
    expect(result.kind).toBe("env");
    if (result.kind !== "env") return;
    expect(result.env.PATH).toBe("/opt/tools/bin:/usr/bin:/bin");
    expect(result.env.PYENV_ROOT).toBe(`${root}/.pyenv`);
    expect(result.env.MULTILINE).toBe("one\ntwo=2");
    // Session state of the shell that printed it, not configuration.
    expect(result.env.PWD).toBeUndefined();
    expect(result.env.SHLVL).toBeUndefined();
  });

  test("does not use syntax fish rejects", async () => {
    // fish refuses `${VAR}` ("Variables cannot be bracketed"), the cause of #138 for fish users.
    const shell = await fakeShell(
      "",
      `case "$4" in *'\${'*) echo "fish: Variables cannot be bracketed" >&2; exit 127;; esac
eval "$4"`,
    );
    const result = await captureLoginShellEnv(shell, BASE_ENV, never);
    expect(result.kind).toBe("env");
  });

  test("falls back to PATH alone where env has no -0", async () => {
    const noNulEnv = join(root, "no-nul-env");
    await mkdir(noNulEnv);
    await writeFile(
      join(noNulEnv, "env"),
      "#!/bin/sh\necho 'env: illegal option -- 0' >&2\nexit 1\n",
    );
    await chmod(join(noNulEnv, "env"), 0o755);
    const shell = await fakeShell(`export PATH="${noNulEnv}:$PATH" OTHER=1`);
    const result = await captureLoginShellEnv(shell, BASE_ENV, never);
    expect(result).toEqual({ kind: "env", env: { PATH: `${noNulEnv}:/usr/bin:/bin` } });
  });

  test("reports a shell that cannot run the command", async () => {
    // tcsh, for one, refuses `-l` combined with other options.
    const shell = await fakeShell("echo 'Unknown option: -i' >&2; exit 1");
    expect(await captureLoginShellEnv(shell, BASE_ENV, never)).toEqual({ kind: "no-output" });
  });

  test("returns once the closing sentinel arrives, even with stdout held open", async () => {
    const pidFile = join(root, "daemon.pid");
    const shell = await fakeShell(`sleep 300 & echo $! > "${pidFile}"`);
    try {
      const result = await captureLoginShellEnv(shell, BASE_ENV, never);
      expect(result.kind).toBe("env");
    } finally {
      process.kill(Number(await readFile(pidFile, "utf8")), "SIGKILL");
    }
  });

  test("kills a hung startup's whole process group when aborted", async () => {
    const pidFile = join(root, "hung.pid");
    const readyFile = join(root, "hung.ready");
    const shell = await fakeShell(
      `sleep 300 & echo $! > "${pidFile}"; mv "${pidFile}" "${readyFile}"; wait`,
    );
    const timeout = new AbortController();
    const capture = captureLoginShellEnv(shell, BASE_ENV, timeout.signal);
    const pid = await waitForPid(readyFile);
    timeout.abort();
    expect(await capture).toEqual({ kind: "aborted" });
    await waitUntilGone(pid);
  });
});

describe("LoginShellEnv", () => {
  /** A shell that counts its runs and sets a variable; `env` before the `-c` command. */
  async function countingShell(): Promise<{ shell: string; runs: () => Promise<number> }> {
    const countFile = join(root, `count-${shellCount + 1}`);
    await writeFile(countFile, "");
    const shell = await fakeShell(
      `echo run >> "${countFile}"; export PATH="/opt/tools/bin:$PATH" LOXEL_TEST_FROM_SHELL=yes`,
    );
    const runs = async () => (await readFile(countFile, "utf8")).split("\n").filter(Boolean).length;
    return { shell, runs };
  }

  test("keeps only the variables the shell set or changed", async () => {
    const { shell } = await countingShell();
    const env = new LoginShellEnv({ shell });
    await env.resolve();
    expect(env.captured?.LOXEL_TEST_FROM_SHELL).toBe("yes");
    expect(env.captured?.PATH).toBe(`/opt/tools/bin:${process.env.PATH}`);
    expect(env.captured?.HOME).toBeUndefined();
  });

  test("shares one capture between concurrent callers", async () => {
    const { shell, runs } = await countingShell();
    const env = new LoginShellEnv({ shell, minRefreshIntervalMs: 0 });
    await Promise.all([env.resolve(), env.resolve(), env.refresh(), env.refresh()]);
    expect(await runs()).toBe(1);
  });

  test("refreshes only after startup resolved, and not within the minimum interval", async () => {
    const { shell, runs } = await countingShell();
    const env = new LoginShellEnv({ shell, minRefreshIntervalMs: 60 * 60_000 });
    await env.refresh();
    expect(await runs()).toBe(0);
    await env.resolve();
    await env.refresh();
    expect(await runs()).toBe(1);
  });

  test("tells listeners when a capture changed the environment, until they unsubscribe", async () => {
    const versionFile = join(root, "env-version");
    await writeFile(versionFile, "1");
    const shell = await fakeShell(`export LOXEL_TEST_VERSION="$(cat "${versionFile}")"`);
    const env = new LoginShellEnv({ shell, minRefreshIntervalMs: 0 });
    const calls: string[][] = [];
    const unsubscribe = env.onChange((names) => calls.push([...names]));
    await env.resolve();
    expect(calls.length).toBe(1);
    await env.refresh();
    expect(calls.length).toBe(1);
    await writeFile(versionFile, "2");
    await env.refresh();
    expect(calls).toEqual([expect.arrayContaining(["LOXEL_TEST_VERSION"]), ["LOXEL_TEST_VERSION"]]);
    unsubscribe();
    await writeFile(versionFile, "3");
    await env.refresh();
    expect(calls.length).toBe(2);
    expect(env.captured?.LOXEL_TEST_VERSION).toBe("3");
  });
});
