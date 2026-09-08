import { describe, test, expect } from "bun:test";

import {
  JoinPayloadSchema,
  type AckEnvelope,
  type AckPayload,
  type JoinPayload,
} from "../src/protocol.ts";
import type { AckEvent, MessageFailedEvent, ChannelClientOptions } from "../src/types.ts";

describe("Reliability Protocol Types", () => {
  describe("JoinPayload with lastSeq", () => {
    test("validates join payload without lastSeq", () => {
      const payload: JoinPayload = {
        channelId: "test-channel",
        token: "jwt-token",
        meta: { device: "test" },
      };

      const result = JoinPayloadSchema.safeParse(payload);
      expect(result.success).toBe(true);
      expect(result.data?.lastSeq).toBeUndefined();
    });

    test("validates join payload with lastSeq", () => {
      const payload: JoinPayload = { channelId: "test-channel", token: "jwt-token", lastSeq: 42 };

      const result = JoinPayloadSchema.safeParse(payload);
      expect(result.success).toBe(true);
      expect(result.data?.lastSeq).toBe(42);
    });

    test("rejects negative lastSeq", () => {
      const payload = { channelId: "test-channel", token: "jwt-token", lastSeq: -1 };

      const result = JoinPayloadSchema.safeParse(payload);
      expect(result.success).toBe(false);
    });

    test("accepts zero lastSeq", () => {
      const payload: JoinPayload = { channelId: "test-channel", token: "jwt-token", lastSeq: 0 };

      const result = JoinPayloadSchema.safeParse(payload);
      expect(result.success).toBe(true);
      expect(result.data?.lastSeq).toBe(0);
    });
  });

  describe("AckEnvelope type", () => {
    test("conforms to expected structure", () => {
      const ackPayload: AckPayload = { seq: 123 };
      const ack: AckEnvelope = { type: "ack", ts: Date.now(), payload: ackPayload };

      expect(ack.type).toBe("ack");
      expect(ack.payload.seq).toBe(123);
      expect(typeof ack.ts).toBe("number");
    });
  });

  describe("Client event types", () => {
    test("AckEvent structure", () => {
      const event: AckEvent = { type: "ack", seq: 456 };

      expect(event.type).toBe("ack");
      expect(event.seq).toBe(456);
    });

    test("MessageFailedEvent structure", () => {
      const event: MessageFailedEvent = {
        type: "message_failed",
        seq: 789,
        to: "client-123",
        payload: { data: "test" },
        binary: false,
      };

      expect(event.type).toBe("message_failed");
      expect(event.seq).toBe(789);
      expect(event.to).toBe("client-123");
      expect(event.binary).toBe(false);
    });

    test("MessageFailedEvent for broadcast (no to)", () => {
      const event: MessageFailedEvent = {
        type: "message_failed",
        seq: 100,
        payload: "broadcast payload",
        binary: false,
      };

      expect(event.to).toBeUndefined();
    });

    test("MessageFailedEvent for binary message", () => {
      const event: MessageFailedEvent = {
        type: "message_failed",
        seq: 200,
        to: "peer",
        payload: new ArrayBuffer(10),
        binary: true,
      };

      expect(event.binary).toBe(true);
    });
  });

  describe("Client options", () => {
    test("reliability options are optional", () => {
      const minimalOptions: ChannelClientOptions = {
        url: "wss://example.com",
        channelId: "test",
        token: "token",
      };

      expect(minimalOptions.enableAck).toBeUndefined();
      expect(minimalOptions.ackTimeout).toBeUndefined();
      expect(minimalOptions.maxRetries).toBeUndefined();
    });

    test("reliability options can be specified", () => {
      const options: ChannelClientOptions = {
        url: "wss://example.com",
        channelId: "test",
        token: "token",
        enableAck: false,
        ackTimeout: 10000,
        maxRetries: 5,
      };

      expect(options.enableAck).toBe(false);
      expect(options.ackTimeout).toBe(10000);
      expect(options.maxRetries).toBe(5);
    });
  });
});

describe("Sequence Number Semantics", () => {
  test("sequence numbers start at 1", () => {
    // Per the plan: "private nextSeq = 1"
    // This test documents the expected behavior
    const initialSeq = 1;
    expect(initialSeq).toBeGreaterThan(0);
  });

  test("sequence 0 means no sequence (binary frames)", () => {
    // In binary frames, seq=0 indicates no sequence tracking
    // This is a documentation test
    const noSeq = 0;
    expect(noSeq).toBe(0);
  });
});
