import { describe, expect, test } from "bun:test";

import { MessageBuffer, type BufferedMessage } from "../src/message-buffer.ts";

function jsonMessage(seq: number, payload: unknown = { seq }): BufferedMessage {
  return { seq, from: "sender", payload, ts: seq, isBroadcast: true };
}

function binaryMessage(seq: number, byteLength: number): BufferedMessage {
  return {
    seq,
    from: "sender",
    to: "recipient",
    payload: null,
    ts: seq,
    isBroadcast: false,
    binaryPayload: new ArrayBuffer(byteLength),
  };
}

describe("MessageBuffer", () => {
  test("keeps at most maxEntries messages, evicting the oldest", () => {
    const buffer = new MessageBuffer({ maxEntries: 3, maxBytes: Number.MAX_SAFE_INTEGER });
    for (let seq = 1; seq <= 5; seq++) {
      buffer.push(jsonMessage(seq));
    }

    expect(buffer.size).toBe(3);
    expect(buffer.after(0).map((message) => message.seq)).toEqual([3, 4, 5]);
  });

  test("evicts oldest binary payloads until under the byte budget", () => {
    const buffer = new MessageBuffer({ maxEntries: 100, maxBytes: 1000 });
    buffer.push(binaryMessage(1, 400));
    buffer.push(binaryMessage(2, 400));
    expect(buffer.bytes).toBe(800);

    buffer.push(binaryMessage(3, 400));
    expect(buffer.size).toBe(2);
    expect(buffer.bytes).toBe(800);
    expect(buffer.after(0).map((message) => message.seq)).toEqual([2, 3]);
  });

  test("a single payload above the budget evicts everything, including itself", () => {
    const buffer = new MessageBuffer({ maxEntries: 100, maxBytes: 1000 });
    buffer.push(binaryMessage(1, 100));
    buffer.push(binaryMessage(2, 5000));

    expect(buffer.size).toBe(0);
    expect(buffer.bytes).toBe(0);
  });

  test("counts JSON payloads against the byte budget", () => {
    const buffer = new MessageBuffer({ maxEntries: 100, maxBytes: 50 });
    buffer.push(jsonMessage(1, "x".repeat(30)));
    buffer.push(jsonMessage(2, "y".repeat(30)));

    expect(buffer.size).toBe(1);
    expect(buffer.after(0).map((message) => message.seq)).toEqual([2]);
  });

  test("after() returns only messages above lastSeq", () => {
    const buffer = new MessageBuffer({ maxEntries: 10, maxBytes: 10_000 });
    buffer.push(jsonMessage(1));
    buffer.push(jsonMessage(2));
    buffer.push(binaryMessage(3, 8));

    expect(buffer.after(1).map((message) => message.seq)).toEqual([2, 3]);
    expect(buffer.after(3)).toEqual([]);
  });
});
