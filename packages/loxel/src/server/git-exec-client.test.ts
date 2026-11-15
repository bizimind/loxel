import { afterEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readOnlyGitEnv } from "./git-commands";
import { createGitExecWorker, GitExecClient, type GitExecWorker } from "./git-exec-client";

function text(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

const clients: GitExecClient[] = [];
afterEach(() => {
  for (const client of clients.splice(0)) client.stop();
});

/** A client whose workers the test can reach, to kill them. */
function trackedClient() {
  const workers: Worker[] = [];
  const client = new GitExecClient(() => {
    const worker = createGitExecWorker();
    workers.push(worker);
    return worker;
  });
  clients.push(client);
  return { client, workers };
}

/** Git args that run `script` through a shell, for controlling output, exit code and timing. */
function shellArgs(script: string): string[] {
  return ["-c", `alias.probe=!${script}`, "probe"];
}

const env = readOnlyGitEnv();

/** In flight for as long as the test needs; dies of SIGPIPE once its worker is gone. */
const FOREVER = { args: shellArgs("while echo x; do sleep 0.1; done"), env };

describe("GitExecClient", () => {
  test("returns stdout, stderr and the exit code as bytes", async () => {
    const { client } = trackedClient();
    const result = await client.exec({
      args: shellArgs("printf 'out\\377'; printf err >&2; exit 3"),
      env,
    });
    expect(result.stdout).toEqual(new Uint8Array([0x6f, 0x75, 0x74, 0xff]));
    expect(text(result.stderr)).toBe("err");
    expect(result.exitCode).toBe(3);
  });

  test("passes env and stdin to the child", async () => {
    const { client } = trackedClient();
    const result = await client.exec({
      args: shellArgs('cat; printf "|%s|%s" "$PROBE" "$GIT_OPTIONAL_LOCKS"'),
      env: { ...env, PROBE: "value" },
      stdin: new TextEncoder().encode("input"),
    });
    expect(text(result.stdout)).toBe("input|value|0");
  });

  test("transfers output when both streams are empty", async () => {
    const { client } = trackedClient();
    const result = await client.exec({ args: shellArgs("true"), env });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.length + result.stderr.length).toBe(0);
  });

  test("reports a git that cannot start as exit 1, without rejecting", async () => {
    const { client } = trackedClient();
    const result = await client.exec({ args: ["--version"], env: { PATH: "/nonexistent" } });
    expect(result.exitCode).toBe(1);
    expect(text(result.stderr)).not.toBe("");
  });

  test("each request gets its own result, whatever order they finish in", async () => {
    const { client } = trackedClient();
    // The first finishes only after the last has created the file it waits for.
    const marker = join(tmpdir(), `git-exec-${crypto.randomUUID()}`);
    const first = client.exec({
      args: shellArgs(
        `until [ -e "${marker}" ]; do sleep 0.01; done; rm "${marker}"; printf first`,
      ),
      env,
    });
    const second = await client.exec({ args: shellArgs("printf second"), env });
    expect(text(second.stdout)).toBe("second");
    await client.exec({ args: shellArgs(`touch "${marker}"`), env });
    expect(text((await first).stdout)).toBe("first");
  });

  test("a worker that dies fails what was in flight and the next request starts a new one", async () => {
    const { client, workers } = trackedClient();
    await client.exec({ args: ["--version"], env });
    const inFlight = client.exec(FOREVER);
    workers[0]!.terminate();
    await expect(inFlight).rejects.toThrow(
      /Git exec worker stopped while running git probe: it exited unexpectedly/,
    );
    const next = await client.exec({ args: shellArgs("printf alive"), env });
    expect(text(next.stdout)).toBe("alive");
    expect(workers).toHaveLength(2);
  });

  test("a worker that throws fails what was in flight with the error's own text", async () => {
    const source = 'self.onmessage = () => { throw new Error("boom in worker"); };';
    const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
    const client = new GitExecClient(() => new Worker(url) as GitExecWorker);
    clients.push(client);
    await expect(client.exec({ args: ["status"], env })).rejects.toThrow(
      /while running git status: it failed: error: boom in worker$/,
    );
  });

  test("stop fails what is in flight", async () => {
    const { client } = trackedClient();
    const inFlight = client.exec(FOREVER);
    client.stop();
    await expect(inFlight).rejects.toThrow(/shutting down/);
  });

  test("large output arrives intact", async () => {
    const { client } = trackedClient();
    const result = await client.exec({ args: shellArgs("head -c 5000000 /dev/zero"), env });
    expect(result.stdout.length).toBe(5_000_000);
  });
});
