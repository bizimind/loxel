/**
 * Streaming handle for a process running inside a sandbox. Wraps a `Bun.spawn`
 * subprocess; the underlying CLI (docker/podman/apple) is responsible for
 * forwarding streams and signals to the in-container process.
 *
 * Signal forwarding notes:
 * - Docker `exec`: forwards SIGTERM/SIGINT to the in-container process.
 * - Podman `exec`: forwards signals when run with a pseudo-tty; best-effort
 *   otherwise.
 * - Apple `container exec`: signal forwarding is undocumented.
 *
 * `kill()` sends the signal to the local CLI subprocess. If you need
 * guaranteed delivery to the in-container process, run a signal-handling
 * supervisor inside the container (e.g. `tini`) or send a kill via
 * `sandbox.exec(["kill", "-TERM", String(pid)])`.
 *
 * Both `stdout` and `stderr` must be drained by the consumer — OS pipe
 * buffers are bounded (typically 64 KiB), so reading only one side can
 * deadlock the subprocess once the other side fills. If you only care
 * about stdout, pipe stderr to a sink: `handle.stderr.pipeTo(new WritableStream())`.
 */
export interface ExecHandle {
  stdin: WritableStream<Uint8Array>;
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exited: Promise<number>;
  kill(signal?: string | number): Promise<void>;
}

type BunSubprocess = ReturnType<typeof Bun.spawn>;

function requireStream<T>(value: T | number | undefined | null, name: string): T {
  if (!value || typeof value === "number") {
    throw new Error(`createExecHandle: subprocess must be spawned with piped ${name}`);
  }
  return value;
}

/**
 * Wrap a `Bun.spawn` subprocess as an `ExecHandle`.
 * Requires the subprocess to have been spawned with
 * `stdin: "pipe"`, `stdout: "pipe"`, `stderr: "pipe"`.
 */
export function createExecHandle(proc: BunSubprocess): ExecHandle {
  const stdout = requireStream(proc.stdout, "stdout");
  const stderr = requireStream(proc.stderr, "stderr");
  const stdin = requireStream(proc.stdin, "stdin");

  return {
    stdin: toWritableStream(stdin),
    stdout,
    stderr,
    exited: proc.exited,
    async kill(signal?: string | number): Promise<void> {
      // Bun's proc.kill accepts number | NodeJS.Signals — string matches the
      // Signals union at runtime (e.g. "SIGTERM"). Narrow via cast to keep the
      // public API free of Node's global type namespace.
      proc.kill(signal as number | undefined);
    },
  };
}

/**
 * Wrap a Bun `FileSink` in a web-standard WritableStream<Uint8Array>.
 * Awaits `sink.write()` for backpressure and `sink.end()` on close so the
 * producer can rely on standard stream semantics.
 */
function toWritableStream(sink: Bun.FileSink): WritableStream<Uint8Array> {
  return new WritableStream<Uint8Array>({
    async write(chunk) {
      // FileSink.write returns a number synchronously, or a Promise<number>
      // once the internal buffer is non-trivially full. Awaiting both is safe
      // and gives the caller backpressure.
      await sink.write(chunk);
    },
    async close() {
      await sink.end();
    },
    async abort() {
      await sink.end();
    },
  });
}
