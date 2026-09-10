import { CliError } from "./errors.ts";
import type { ExecResult } from "./provider.ts";

/** Sanitize command args for error messages — redact values after -e flags. */
function sanitizeCommand(args: string[]): string[] {
  const sanitized: string[] = [];
  let redactNext = false;
  for (const arg of args) {
    if (redactNext) {
      const eqIdx = arg.indexOf("=");
      sanitized.push(eqIdx >= 0 ? `${arg.slice(0, eqIdx + 1)}[REDACTED]` : arg);
      redactNext = false;
      continue;
    }
    sanitized.push(arg);
    if (arg === "-e") redactNext = true;
  }
  return sanitized;
}

/**
 * Run a CLI command and collect output.
 * Uses Bun.spawn for subprocess control with stdout/stderr separation.
 */
export async function runCli(
  args: string[],
  options?: { throwOnError?: boolean; timeout?: number },
): Promise<ExecResult> {
  const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });

  const collectOutput = async () => {
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const exitCode = await proc.exited;
    return { exitCode, stdout, stderr };
  };

  let result: ExecResult;
  if (options?.timeout !== undefined && options.timeout > 0) {
    const timeoutMs = options.timeout;
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        abort.abort();
        proc.kill();
        // Escalate to SIGKILL after 2 s if the process ignores SIGTERM.
        setTimeout(() => proc.kill(9), 2000);
        reject(
          new CliError({
            command: sanitizeCommand(args),
            exitCode: -1,
            stderr: "",
            message: `Command timed out after ${timeoutMs}ms: ${sanitizeCommand(args).join(" ")}`,
          }),
        );
      }, timeoutMs);
    });

    const collectWithAbort = async () => {
      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout, { signal: abort.signal } as ResponseInit).text(),
        new Response(proc.stderr, { signal: abort.signal } as ResponseInit).text(),
      ]);
      const exitCode = await proc.exited;
      return { exitCode, stdout, stderr };
    };

    try {
      result = await Promise.race([collectWithAbort(), timeoutPromise]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  } else {
    result = await collectOutput();
  }

  if (options?.throwOnError !== false && result.exitCode !== 0) {
    throw new CliError({
      command: sanitizeCommand(args),
      exitCode: result.exitCode,
      stderr: result.stderr,
    });
  }

  return result;
}

/**
 * Run a CLI command and parse stdout as JSON.
 * Returns `unknown` — callers must narrow the result.
 */
export async function runCliJson(args: string[]): Promise<unknown> {
  const result = await runCli(args);
  return JSON.parse(result.stdout) as unknown;
}

/**
 * Spawn a long-running CLI command and return a ReadableStream of stdout lines.
 * Uses Bun.spawn for streaming — suitable for `logs --follow` and similar.
 */
export function spawnCliStream(
  args: string[],
  options?: { signal?: AbortSignal },
): ReadableStream<string> {
  // Pipe stderr so we can drain it — otherwise a noisy subprocess (e.g. `docker logs`
  // writing container stderr to its own stderr on some versions) can block once the
  // kernel pipe buffer fills. We drain it to a discard sink.
  const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
  void proc.stderr.pipeTo(new WritableStream()).catch(() => {});

  if (options?.signal) {
    options.signal.addEventListener("abort", () => proc.kill(), { once: true });
  }

  let buffer = "";

  const lineStream = proc.stdout.pipeThrough(new TextDecoderStream()).pipeThrough(
    new TransformStream<string, string>({
      transform(chunk, controller) {
        buffer += chunk;
        const lines = buffer.split("\n");
        // Keep the last partial line in the buffer
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (line) controller.enqueue(line);
        }
      },
      flush(controller) {
        if (buffer) controller.enqueue(buffer);
      },
    }),
  );

  const reader = lineStream.getReader();
  return new ReadableStream<string>({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        controller.close();
      } else {
        controller.enqueue(value);
      }
    },
    cancel() {
      // Kill the subprocess when the consumer abandons the stream,
      // otherwise long-running commands (e.g. `docker logs -f`) leak.
      reader.cancel().catch(() => {});
      proc.kill();
    },
  });
}
