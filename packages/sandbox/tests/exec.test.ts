import { describe, expect, test } from "bun:test";

import { CliError } from "../src/errors.ts";
import { createExecHandle } from "../src/exec-handle.ts";
import { runCli, runCliJson, spawnCliStream } from "../src/exec.ts";

describe("runCli", () => {
  test("captures stdout from a successful command", async () => {
    const result = await runCli(["echo", "hello"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("hello");
    expect(result.stderr).toBe("");
  });

  test("throws CliError on non-zero exit by default", async () => {
    await expect(runCli(["false"])).rejects.toBeInstanceOf(CliError);
  });

  test("returns non-zero exit without throwing when throwOnError is false", async () => {
    const result = await runCli(["false"], { throwOnError: false });
    expect(result.exitCode).not.toBe(0);
  });

  test("captures stderr", async () => {
    const result = await runCli(["sh", "-c", "echo err >&2; exit 0"]);
    expect(result.stderr.trim()).toBe("err");
  });

  test("CliError contains structured command, exit code, and code='cli_failed'", async () => {
    try {
      await runCli(["sh", "-c", "echo bad >&2; exit 42"]);
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(CliError);
      const cliError = error as CliError;
      expect(cliError.code).toBe("cli_failed");
      expect(cliError.exitCode).toBe(42);
      expect(cliError.stderr.trim()).toBe("bad");
      expect(cliError.command[0]).toBe("sh");
    }
  });

  test("redacts -e flag values", async () => {
    try {
      await runCli(["sh", "-c", "exit 1", "-e", "SECRET=abc"]);
      expect.unreachable("should have thrown");
    } catch (error) {
      const cliError = error as CliError;
      expect(cliError.command).toContain("SECRET=[REDACTED]");
    }
  });
});

describe("runCliJson", () => {
  test("parses JSON from stdout", async () => {
    const result = await runCliJson(["sh", "-c", 'echo \'{"hello":"world"}\'']);
    expect(result).toEqual({ hello: "world" });
  });

  test("parses JSON array from stdout", async () => {
    const result = await runCliJson(["sh", "-c", "echo '[1,2,3]'"]);
    expect(result).toEqual([1, 2, 3]);
  });
});

describe("spawnCliStream", () => {
  test("streams lines from stdout", async () => {
    const stream = spawnCliStream(["sh", "-c", 'echo "line1"; echo "line2"; echo "line3"']);
    const lines: string[] = [];

    for await (const line of stream) {
      lines.push(line);
    }

    expect(lines).toEqual(["line1", "line2", "line3"]);
  });

  test("can be aborted via signal", async () => {
    const controller = new AbortController();
    const stream = spawnCliStream(["sh", "-c", "while true; do echo tick; sleep 0.1; done"], {
      signal: controller.signal,
    });

    const reader = stream.getReader();
    const first = await reader.read();
    expect(first.value).toBe("tick");

    controller.abort();

    // Stream should eventually end after abort
    let done = false;
    while (!done) {
      const result = await reader.read();
      done = result.done;
    }
    expect(done).toBe(true);
  });
});

describe("createExecHandle", () => {
  test("wraps a Bun.spawn subprocess with piped stdio", async () => {
    const proc = Bun.spawn(["cat"], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    const handle = createExecHandle(proc);

    const writer = handle.stdin.getWriter();
    await writer.write(new TextEncoder().encode("hello\n"));
    await writer.close();

    const exitCode = await handle.exited;
    expect(exitCode).toBe(0);

    const stdout = await new Response(handle.stdout).text();
    expect(stdout).toBe("hello\n");
  });

  test("kill() terminates the subprocess", async () => {
    const proc = Bun.spawn(["sh", "-c", "sleep 30"], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    const handle = createExecHandle(proc);

    await handle.kill("SIGTERM");
    const exitCode = await handle.exited;
    expect(exitCode).not.toBe(0);
  });

  test("streams stdout independently of stderr", async () => {
    const proc = Bun.spawn(["sh", "-c", "echo out; echo err >&2"], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    const handle = createExecHandle(proc);

    const [out, err] = await Promise.all([
      new Response(handle.stdout).text(),
      new Response(handle.stderr).text(),
    ]);
    await handle.exited;

    expect(out.trim()).toBe("out");
    expect(err.trim()).toBe("err");
  });
});
