import { describe, test, expect } from "bun:test";

import {
  encodeBinaryFrame,
  decodeBinaryFrame,
  BINARY_HEADER_SIZE,
  type BinaryFrame,
} from "../src/protocol.ts";

describe("Binary Frame Encoding", () => {
  test("encodes and decodes a targeted message", () => {
    const frame: BinaryFrame = {
      isBinary: true,
      isBroadcast: false,
      seq: 42,
      from: "client-abc",
      to: "client-xyz",
      payload: new Uint8Array([1, 2, 3, 4, 5]).buffer,
    };

    const encoded = encodeBinaryFrame(frame);
    expect(encoded.byteLength).toBe(BINARY_HEADER_SIZE + 5);

    const decoded = decodeBinaryFrame(encoded);
    expect(decoded.isBinary).toBe(true);
    expect(decoded.isBroadcast).toBe(false);
    expect(decoded.seq).toBe(42);
    expect(decoded.from).toBe("client-abc");
    expect(decoded.to).toBe("client-xyz");
    expect(new Uint8Array(decoded.payload)).toEqual(new Uint8Array([1, 2, 3, 4, 5]));
  });

  test("encodes and decodes a broadcast message", () => {
    const frame: BinaryFrame = {
      isBinary: true,
      isBroadcast: true,
      seq: 1,
      from: "sender",
      payload: new ArrayBuffer(0),
    };

    const encoded = encodeBinaryFrame(frame);
    expect(encoded.byteLength).toBe(BINARY_HEADER_SIZE);

    const decoded = decodeBinaryFrame(encoded);
    expect(decoded.isBinary).toBe(true);
    expect(decoded.isBroadcast).toBe(true);
    expect(decoded.seq).toBe(1);
    expect(decoded.from).toBe("sender");
    expect(decoded.to).toBeUndefined();
    expect(decoded.payload.byteLength).toBe(0);
  });

  test("handles maximum client ID length", () => {
    const frame: BinaryFrame = {
      isBinary: true,
      isBroadcast: false,
      seq: 100,
      from: "1234567890123456", // 16 chars exactly
      to: "abcdefghijklmnop", // 16 chars exactly
      payload: new Uint8Array([255]).buffer,
    };

    const encoded = encodeBinaryFrame(frame);
    const decoded = decodeBinaryFrame(encoded);

    expect(decoded.from).toBe("1234567890123456");
    expect(decoded.to).toBe("abcdefghijklmnop");
  });

  test("truncates oversized client IDs", () => {
    const frame: BinaryFrame = {
      isBinary: true,
      isBroadcast: false,
      seq: 1,
      from: "this-is-a-very-long-client-id-that-exceeds-16-chars",
      to: "another-very-long-client-id-here",
      payload: new ArrayBuffer(0),
    };

    const encoded = encodeBinaryFrame(frame);
    const decoded = decodeBinaryFrame(encoded);

    expect(decoded.from.length).toBe(16);
    expect(decoded.to?.length).toBe(16);
  });

  test("handles large sequence numbers", () => {
    const frame: BinaryFrame = {
      isBinary: false,
      isBroadcast: false,
      seq: 0xffffffff, // Max uint32
      from: "a",
      to: "b",
      payload: new ArrayBuffer(0),
    };

    const encoded = encodeBinaryFrame(frame);
    const decoded = decodeBinaryFrame(encoded);

    expect(decoded.seq).toBe(0xffffffff);
  });

  test("handles binary flag variations", () => {
    const jsonFrame: BinaryFrame = {
      isBinary: false,
      isBroadcast: false,
      seq: 1,
      from: "a",
      to: "b",
      payload: new ArrayBuffer(0),
    };

    const decoded = decodeBinaryFrame(encodeBinaryFrame(jsonFrame));
    expect(decoded.isBinary).toBe(false);
    expect(decoded.isBroadcast).toBe(false);
  });

  test("throws on undersized buffer", () => {
    const smallBuffer = new ArrayBuffer(10);
    expect(() => decodeBinaryFrame(smallBuffer)).toThrow("Binary frame too small");
  });

  test("handles empty payload", () => {
    const frame: BinaryFrame = {
      isBinary: true,
      isBroadcast: true,
      seq: 0,
      from: "sender",
      payload: new ArrayBuffer(0),
    };

    const encoded = encodeBinaryFrame(frame);
    const decoded = decodeBinaryFrame(encoded);

    expect(decoded.payload.byteLength).toBe(0);
  });

  test("handles large payload", () => {
    const largePayload = new Uint8Array(10000);
    for (let i = 0; i < largePayload.length; i++) {
      largePayload[i] = i % 256;
    }

    const frame: BinaryFrame = {
      isBinary: true,
      isBroadcast: false,
      seq: 999,
      from: "sender",
      to: "receiver",
      payload: largePayload.buffer,
    };

    const encoded = encodeBinaryFrame(frame);
    expect(encoded.byteLength).toBe(BINARY_HEADER_SIZE + 10000);

    const decoded = decodeBinaryFrame(encoded);
    expect(new Uint8Array(decoded.payload)).toEqual(largePayload);
  });
});
