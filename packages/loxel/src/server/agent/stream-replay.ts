/**
 * Test harness that replays a recorded stream-json session instead of running `claude`. A
 * recording is NDJSON of `{ dir: "out" | "in", frame }`: what Loxel wrote to the CLI and what the
 * CLI answered, captured against the real CLI (see docs/AGENT_PANEL.md#recordings). Each frame the
 * transport writes must match the next recorded "out" frame; the "in" frames recorded after it are
 * then fed back until the next "out".
 */
import { isRecord } from "@/lib/is-record";

import type { ClaudeStreamTransport, StreamProcess } from "./claude-stream-transport";

interface Recorded {
  dir: "out" | "in";
  frame: Record<string, unknown>;
}

/** The part of an outbound frame a replay checks: its kind, not its ids or text. */
export function frameShape(frame: Record<string, unknown>): string {
  const request = isRecord(frame.request) ? frame.request : null;
  const response = isRecord(frame.response) ? frame.response : null;
  const result = isRecord(response?.response) ? response.response : null;
  return [frame.type, request?.subtype ?? result?.behavior ?? ""].join(":");
}

export class StreamReplay {
  private readonly records: Recorded[];
  private cursor = 0;
  private transport: ClaudeStreamTransport | null = null;
  /** Recorded request ids by the ids the transport used for the same requests, in order. */
  private readonly outboundIds: string[] = [];
  private readonly recordedIds: string[] = [];
  readonly written: Record<string, unknown>[] = [];
  private resolveExit: (code: number) => void = () => {};
  private readonly exit = new Promise<number>((resolve) => {
    this.resolveExit = resolve;
  });

  constructor(ndjson: string) {
    this.records = ndjson
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => {
        const parsed: unknown = JSON.parse(line);
        if (!isRecord(parsed) || !isRecord(parsed.frame)) throw new Error("Bad recording line");
        return { dir: parsed.dir === "out" ? "out" : "in", frame: parsed.frame };
      });
  }

  bind(transport: ClaudeStreamTransport): void {
    this.transport = transport;
  }

  /** The process the transport's factory returns. */
  process(): StreamProcess {
    return {
      writeLine: (line) => this.onWrite(line),
      endInput: () => this.resolveExit(0),
      // Frames are fed by handleFrame; the output stream ends when the process does.
      lines: {
        [Symbol.asyncIterator]: () => ({
          next: () => this.exit.then(() => ({ done: true as const, value: undefined })),
        }),
      },
      exited: this.exit,
      stderrTail: () => "",
      kill: () => this.resolveExit(143),
    };
  }

  /** Outbound frames the recording still expects. */
  remaining(): string[] {
    return this.records
      .slice(this.cursor)
      .flatMap((r) => (r.dir === "out" ? [frameShape(r.frame)] : []));
  }

  private onWrite(line: string): void {
    const frame: unknown = JSON.parse(line);
    if (!isRecord(frame)) throw new Error("Transport wrote a non-object frame");
    this.written.push(frame);
    const expected = this.records[this.cursor];
    if (!expected || expected.dir !== "out") {
      throw new Error(`Unexpected write ${frameShape(frame)}; recording expects input next`);
    }
    if (frameShape(expected.frame) !== frameShape(frame)) {
      throw new Error(
        `Wrote ${frameShape(frame)}, recording expects ${frameShape(expected.frame)}`,
      );
    }
    if (frame.type === "control_request" && typeof frame.request_id === "string") {
      this.outboundIds.push(frame.request_id);
      this.recordedIds.push(String(expected.frame.request_id));
    }
    this.cursor += 1;
    this.feed();
  }

  private feed(): void {
    while (this.records[this.cursor]?.dir === "in") {
      const { frame } = this.records[this.cursor]!;
      this.cursor += 1;
      this.transport?.handleFrame(this.withTransportIds(frame));
    }
  }

  /** A recorded control response, renumbered to the request id the transport used. */
  private withTransportIds(frame: Record<string, unknown>): Record<string, unknown> {
    if (frame.type !== "control_response" || !isRecord(frame.response)) return frame;
    const index = this.recordedIds.indexOf(String(frame.response.request_id));
    if (index === -1) return frame;
    return { ...frame, response: { ...frame.response, request_id: this.outboundIds[index] } };
  }
}
