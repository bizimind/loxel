import type { Readable, Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";

interface PendingCommand {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

interface CdpResponse {
  id: number;
  result?: unknown;
  error?: { message?: string };
}

export interface CdpCommandOptions {
  sessionId?: string;
  timeoutMs?: number;
}

export class ChromeCdpPipe {
  private readonly decoder = new StringDecoder("utf8");
  private readonly pending = new Map<number, PendingCommand>();
  private buffer = "";
  private nextId = 1;
  private closed = false;

  get isClosed(): boolean {
    return this.closed;
  }

  constructor(
    private readonly commandStream: Writable,
    private readonly responseStream: Readable,
  ) {
    responseStream.on("data", this.handleData);
    responseStream.once("end", this.handleEnd);
    responseStream.once("error", this.handleStreamError);
    commandStream.once("error", this.handleStreamError);
  }

  send<T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
    options: CdpCommandOptions = {},
  ): Promise<T> {
    if (this.closed) return Promise.reject(new Error("Chrome debugging connection is closed"));

    const id = this.nextId++;
    const payload: Record<string, unknown> = { id, method, params };
    if (options.sessionId) payload.sessionId = options.sessionId;

    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("Chrome debugging command timed out"));
      }, options.timeoutMs ?? 5_000);

      this.pending.set(id, { resolve: (value) => resolve(value as T), reject, timeout });

      try {
        this.commandStream.write(`${JSON.stringify(payload)}\0`, (error) => {
          if (!error) return;
          const pending = this.pending.get(id);
          if (!pending) return;
          clearTimeout(pending.timeout);
          this.pending.delete(id);
          pending.reject(new Error("Failed to send Chrome debugging command", { cause: error }));
        });
      } catch (error) {
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(new Error("Failed to send Chrome debugging command", { cause: error }));
      }
    });
  }

  close(reason = new Error("Chrome debugging connection closed")): void {
    if (this.closed) return;
    this.closed = true;
    this.responseStream.off("data", this.handleData);
    this.responseStream.off("end", this.handleEnd);
    this.responseStream.off("error", this.handleStreamError);
    this.commandStream.off("error", this.handleStreamError);
    this.rejectPending(reason);
  }

  private readonly handleData = (chunk: Buffer | string): void => {
    this.buffer += typeof chunk === "string" ? chunk : this.decoder.write(chunk);

    let boundary = this.buffer.indexOf("\0");
    while (boundary !== -1) {
      const frame = this.buffer.slice(0, boundary);
      this.buffer = this.buffer.slice(boundary + 1);
      if (frame) this.handleFrame(frame);
      boundary = this.buffer.indexOf("\0");
    }
  };

  private handleFrame(frame: string): void {
    let value: unknown;
    try {
      value = JSON.parse(frame);
    } catch (error) {
      this.close(new Error("Chrome returned an invalid debugging response", { cause: error }));
      return;
    }

    if (!isCdpResponse(value)) return;
    const pending = this.pending.get(value.id);
    if (!pending) return;

    clearTimeout(pending.timeout);
    this.pending.delete(value.id);
    if (value.error) {
      pending.reject(new Error(value.error.message ?? "Chrome debugging command failed"));
    } else {
      pending.resolve(value.result);
    }
  }

  private readonly handleEnd = (): void => {
    this.close();
  };

  private readonly handleStreamError = (error: Error): void => {
    this.close(new Error("Chrome debugging connection failed", { cause: error }));
  };

  private rejectPending(reason: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(reason);
    }
    this.pending.clear();
  }
}

function isCdpResponse(value: unknown): value is CdpResponse {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "number" || !Number.isInteger(record.id)) return false;
  if (record.error === undefined) return true;
  if (!record.error || typeof record.error !== "object") return false;
  const error = record.error as Record<string, unknown>;
  return error.message === undefined || typeof error.message === "string";
}
