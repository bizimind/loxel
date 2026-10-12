import { describe, expect, test } from "bun:test";

import {
  BIN_HEADER_SIZE,
  BIN_MSG_INPUT,
  BIN_MSG_OUTPUT,
  BIN_OUTPUT_HEADER_SIZE,
  clampScrollbackLines,
  clampTerminalSize,
  DEFAULT_SCROLLBACK_LINES,
  encodeInputFrame,
  encodeOutputFrame,
  parseBinaryHeader,
  parseOutputFrame,
} from "./ws-protocol";

const TERMINAL_ID = "0f3c2a1e-7b4d-4c8e-9a6f-123456789abc";

describe("terminal binary frames", () => {
  test("output frames round-trip the offset and payload", () => {
    const payload = new Uint8Array([0x1b, 0x5b, 0x36, 0x6e]);
    const frame = encodeOutputFrame(TERMINAL_ID, 2 ** 40 + 7, payload);
    expect(frame.byteLength).toBe(BIN_OUTPUT_HEADER_SIZE + payload.byteLength);
    expect(parseBinaryHeader(frame)).toEqual({ type: BIN_MSG_OUTPUT, terminalId: TERMINAL_ID });

    const parsed = parseOutputFrame(frame);
    expect(parsed).not.toBeNull();
    expect(parsed!.terminalId).toBe(TERMINAL_ID);
    expect(parsed!.offset).toBe(2 ** 40 + 7);
    expect([...parsed!.payload]).toEqual([...payload]);
  });

  test("output frames parse from a view into a larger buffer", () => {
    const frame = encodeOutputFrame(TERMINAL_ID, 42, new Uint8Array([1, 2, 3]));
    const padded = new Uint8Array(frame.byteLength + 5);
    padded.set(frame, 5);
    const parsed = parseOutputFrame(padded.subarray(5));
    expect(parsed!.offset).toBe(42);
    expect([...parsed!.payload]).toEqual([1, 2, 3]);
  });

  test("short output frames are rejected", () => {
    expect(parseOutputFrame(new Uint8Array(BIN_OUTPUT_HEADER_SIZE - 1))).toBeNull();
  });

  test("input frames carry the payload right after the header", () => {
    const payload = new TextEncoder().encode("ls\r");
    const frame = encodeInputFrame(TERMINAL_ID, payload);
    expect(parseBinaryHeader(frame)).toEqual({ type: BIN_MSG_INPUT, terminalId: TERMINAL_ID });
    expect([...frame.subarray(BIN_HEADER_SIZE)]).toEqual([...payload]);
  });
});

describe("clampTerminalSize", () => {
  test("floors, clamps and falls back for non-finite values", () => {
    expect(clampTerminalSize(120, 40)).toEqual({ cols: 120, rows: 40 });
    expect(clampTerminalSize(120.9, 40.2)).toEqual({ cols: 120, rows: 40 });
    expect(clampTerminalSize(0, 0)).toEqual({ cols: 2, rows: 1 });
    expect(clampTerminalSize(50_000, 50_000)).toEqual({ cols: 1_000, rows: 500 });
    expect(clampTerminalSize(Infinity, NaN)).toEqual({ cols: 80, rows: 24 });
  });
});

describe("clampScrollbackLines", () => {
  test("defaults and clamps", () => {
    expect(clampScrollbackLines(undefined)).toBe(DEFAULT_SCROLLBACK_LINES);
    expect(clampScrollbackLines(10)).toBe(1_000);
    expect(clampScrollbackLines(5_000)).toBe(5_000);
    expect(clampScrollbackLines(10_000_000)).toBe(100_000);
  });
});
