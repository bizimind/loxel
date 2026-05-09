import { describe, expect, test } from "bun:test";

import {
  createLoopDetector,
  MAX_CYCLE_LENGTH,
  MIN_REPETITIONS,
} from "../src/orchestrator/loop-detector.ts";

describe("loop detector", () => {
  test("[A, B, A, B] detects cycle of length 2", () => {
    const detector = createLoopDetector();

    expect(detector.record("A", { x: 1 })).toEqual({ type: "ok" });
    expect(detector.record("B", { y: 2 })).toEqual({ type: "ok" });
    expect(detector.record("A", { x: 1 })).toEqual({ type: "ok" });

    // Fourth call completes the pattern repetition
    const result = detector.record("B", { y: 2 });
    expect(result).toEqual({
      type: "cycle_detected",
      cycleLength: 2,
      repetitions: MIN_REPETITIONS,
    });
  });

  test("[A, B, C, B] does not detect cycle (novel input breaks pattern)", () => {
    const detector = createLoopDetector();

    expect(detector.record("A", { x: 1 })).toEqual({ type: "ok" });
    expect(detector.record("B", { y: 2 })).toEqual({ type: "ok" });
    expect(detector.record("C", { z: 3 })).toEqual({ type: "ok" }); // Novel tool
    expect(detector.record("B", { y: 2 })).toEqual({ type: "ok" }); // Not a cycle

    expect(detector.sequence.length).toBe(4);
  });

  test("[A, B, C, A, B, C] detects cycle of length 3", () => {
    const detector = createLoopDetector();

    expect(detector.record("A", { x: 1 })).toEqual({ type: "ok" });
    expect(detector.record("B", { y: 2 })).toEqual({ type: "ok" });
    expect(detector.record("C", { z: 3 })).toEqual({ type: "ok" });
    expect(detector.record("A", { x: 1 })).toEqual({ type: "ok" });
    expect(detector.record("B", { y: 2 })).toEqual({ type: "ok" });

    // Sixth call completes the pattern repetition
    const result = detector.record("C", { z: 3 });
    expect(result).toEqual({
      type: "cycle_detected",
      cycleLength: 3,
      repetitions: MIN_REPETITIONS,
    });
  });

  test("[A, A, A] detects cycle of length 1 (same tool repeated)", () => {
    const detector = createLoopDetector();

    expect(detector.record("A", { x: 1 })).toEqual({ type: "ok" });

    // Second call completes the pattern (length 1, 2 repetitions)
    const result = detector.record("A", { x: 1 });
    expect(result).toEqual({
      type: "cycle_detected",
      cycleLength: 1,
      repetitions: MIN_REPETITIONS,
    });
  });

  test("different inputs for same tool are not a cycle", () => {
    const detector = createLoopDetector();

    expect(detector.record("A", { x: 1 })).toEqual({ type: "ok" });
    expect(detector.record("A", { x: 2 })).toEqual({ type: "ok" }); // Different input
    expect(detector.record("A", { x: 3 })).toEqual({ type: "ok" }); // Different input
    expect(detector.record("A", { x: 4 })).toEqual({ type: "ok" }); // Different input

    // No cycle because each call has different input
    expect(detector.sequence.length).toBe(4);
  });

  test("input object key order does not affect hash", () => {
    const detector = createLoopDetector();

    expect(detector.record("A", { x: 1, y: 2 })).toEqual({ type: "ok" });

    // Same values but different key order should be detected as same
    const result = detector.record("A", { y: 2, x: 1 });
    expect(result).toEqual({
      type: "cycle_detected",
      cycleLength: 1,
      repetitions: MIN_REPETITIONS,
    });
  });

  test("getRecentCalls returns correct tool call records", () => {
    const detector = createLoopDetector();

    detector.record("Read", { path: "/foo" });
    detector.record("Write", { path: "/bar", content: "hello" });
    detector.record("Bash", { command: "ls" });

    const recent = detector.getRecentCalls(2);
    expect(recent).toHaveLength(2);
    expect(recent[0]?.tool).toBe("Write");
    expect(recent[1]?.tool).toBe("Bash");
  });

  test("reset clears sequence and details", () => {
    const detector = createLoopDetector();

    detector.record("A", { x: 1 });
    detector.record("B", { y: 2 });

    expect(detector.sequence.length).toBe(2);

    detector.reset();

    expect(detector.sequence.length).toBe(0);
    expect(detector.getRecentCalls(10)).toEqual([]);
  });

  test("complex nested input objects are hashed correctly", () => {
    const detector = createLoopDetector();

    const complexInput = { nested: { a: 1, b: { c: 2 } }, array: [1, 2, 3], null_value: null };

    expect(detector.record("Tool", complexInput)).toEqual({ type: "ok" });
    expect(detector.record("Tool", complexInput)).toEqual({
      type: "cycle_detected",
      cycleLength: 1,
      repetitions: MIN_REPETITIONS,
    });
  });

  test("MAX_CYCLE_LENGTH constant is 20", () => {
    expect(MAX_CYCLE_LENGTH).toBe(20);
  });

  test("MIN_REPETITIONS constant is 2", () => {
    expect(MIN_REPETITIONS).toBe(2);
  });

  test("long non-repeating sequence does not trigger false positive", () => {
    const detector = createLoopDetector();

    // Add 30 different tool calls
    for (let i = 0; i < 30; i++) {
      const result = detector.record(`Tool${i}`, { index: i });
      expect(result).toEqual({ type: "ok" });
    }

    expect(detector.sequence.length).toBe(30);
  });

  test("pattern at exactly MAX_CYCLE_LENGTH is detected", () => {
    const detector = createLoopDetector();

    // Create pattern of length MAX_CYCLE_LENGTH
    for (let i = 0; i < MAX_CYCLE_LENGTH; i++) {
      detector.record(`Tool${i}`, { index: i });
    }

    // Repeat the pattern
    for (let i = 0; i < MAX_CYCLE_LENGTH - 1; i++) {
      expect(detector.record(`Tool${i}`, { index: i })).toEqual({ type: "ok" });
    }

    // Last tool of second repetition completes the cycle
    const result = detector.record(`Tool${MAX_CYCLE_LENGTH - 1}`, { index: MAX_CYCLE_LENGTH - 1 });
    expect(result).toEqual({
      type: "cycle_detected",
      cycleLength: MAX_CYCLE_LENGTH,
      repetitions: MIN_REPETITIONS,
    });
  });
});
