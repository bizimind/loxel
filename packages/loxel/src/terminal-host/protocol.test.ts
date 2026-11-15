import { describe, expect, test } from "bun:test";

import { encodeOutputFrame } from "@/api/terminal-stream";

import type { ServerMessage } from "./protocol";
import { HostMessageSchema, ServerMessageSchema, compatibility } from "./protocol";
import { FrameReader, MAX_FRAME_BYTES, encodeFrame, encodeJsonFrame } from "./protocol-framing";

describe("framing", () => {
  test("splits a stream into its JSON and binary bodies however it is chunked", () => {
    const id = crypto.randomUUID();
    const output = encodeOutputFrame(id, 42, new TextEncoder().encode("hello"));
    const stream = new Uint8Array([
      ...encodeJsonFrame({ type: "list", requestId: 1 }),
      ...encodeFrame(output),
      ...encodeJsonFrame({ type: "detach", id }),
    ]);
    for (const size of [1, 3, 7, stream.byteLength]) {
      const reader = new FrameReader();
      const bodies = [];
      for (let start = 0; start < stream.byteLength; start += size) {
        bodies.push(...reader.push(stream.subarray(start, start + size)));
      }
      expect(bodies).toEqual([
        { kind: "json", value: { type: "list", requestId: 1 } },
        { kind: "binary", bytes: output },
        { kind: "json", value: { type: "detach", id } },
      ]);
    }
  });

  test("rejects a length beyond the limit and a malformed JSON body", () => {
    const tooLong = new Uint8Array(4);
    new DataView(tooLong.buffer).setUint32(0, MAX_FRAME_BYTES + 1);
    expect(() => new FrameReader().push(tooLong)).toThrow("exceeds");
    expect(() => new FrameReader().push(encodeFrame(new TextEncoder().encode("{oops")))).toThrow(
      "Malformed JSON frame",
    );
  });
});

describe("messages", () => {
  test("a spawn carries the interface's spawn fields; unknown messages do not parse", () => {
    const spawn: ServerMessage = {
      type: "spawn",
      requestId: 3,
      request: {
        id: crypto.randomUUID(),
        epoch: "e",
        argv: ["/bin/sh"],
        cwd: "/",
        env: { A: "1" },
        cols: 80,
        rows: 24,
        scrollbackLines: 10,
        meta: { worktreePath: "/wt", nested: { list: [1, null] } },
      },
    };
    expect(ServerMessageSchema.parse(spawn)).toEqual(spawn);
    expect(ServerMessageSchema.safeParse({ type: "fly", requestId: 1 }).success).toBe(false);
    expect(
      HostMessageSchema.safeParse({ type: "osc", id: "x", epoch: "e", code: 8, data: "" }).success,
    ).toBe(false);
  });
});

describe("compatibility", () => {
  const peer = (protocol: string, capabilities: string[] = []) => ({ protocol, capabilities });

  test("the same major is compatible whatever the minor and patch, in either direction", () => {
    expect(compatibility(peer("1.4.2"), peer("1.0.0")).status).toBe("compatible");
    expect(compatibility(peer("1.0.0"), peer("1.4.2")).status).toBe("compatible");
  });

  test("a different major, or a version that is not semver, is incompatible", () => {
    expect(compatibility(peer("2.0.0"), peer("1.9.0"))).toMatchObject({ status: "incompatible" });
    expect(compatibility(peer("1.0"), peer("1.0.0"))).toMatchObject({ status: "incompatible" });
  });

  test("capabilities are the ones both sides advertise; the rest are named as unshared", () => {
    expect(
      compatibility(peer("1.2.0", ["foregroundProcess", "a"]), peer("1.1.0", ["a", "b"])),
    ).toEqual({
      status: "degraded",
      capabilities: new Set(["a"]),
      unshared: ["foregroundProcess", "b"],
    });
    expect(compatibility(peer("1.2.0", ["a"]), peer("1.2.0", ["a"]))).toEqual({
      status: "compatible",
      capabilities: new Set(["a"]),
    });
  });
});
