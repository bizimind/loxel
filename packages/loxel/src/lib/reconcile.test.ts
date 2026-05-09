import { describe, expect, test } from "bun:test";

import { reconcile } from "./reconcile";

describe("reconcile", () => {
  // ── Primitives ──

  test("returns current for identical primitives", () => {
    expect(reconcile(42, 42)).toBe(42);
    expect(reconcile("hello", "hello")).toBe("hello");
    expect(reconcile(true, true)).toBe(true);
    expect(reconcile(null, null)).toBe(null);
    expect(reconcile(undefined, undefined)).toBe(undefined);
  });

  test("returns incoming for different primitives", () => {
    expect(reconcile(1, 2)).toBe(2);
    expect(reconcile("a", "b")).toBe("b");
    expect(reconcile(true, false)).toBe(false);
  });

  test("handles null vs undefined", () => {
    expect(reconcile(null, undefined)).toBe(undefined);
    expect(reconcile(undefined, null)).toBe(null);
  });

  test("handles null vs object", () => {
    const obj = { a: 1 };
    expect(reconcile(null, obj)).toBe(obj);
    expect(reconcile(obj, null)).toBe(null);
  });

  // ── Arrays ──

  test("preserves array reference when deeply equal", () => {
    const current = [1, 2, 3];
    const incoming = [1, 2, 3];
    expect(reconcile(current, incoming)).toBe(current);
  });

  test("returns incoming for different length arrays", () => {
    const current = [1, 2];
    const incoming = [1, 2, 3];
    expect(reconcile(current, incoming)).toBe(incoming);
  });

  test("returns new array with reconciled elements when values differ", () => {
    const current = [1, 2, 3];
    const incoming = [1, 99, 3];
    const result = reconcile(current, incoming);
    expect(result).not.toBe(current);
    expect(result).toEqual([1, 99, 3]);
  });

  test("preserves nested object references inside arrays", () => {
    const inner = { x: 1, y: 2 };
    const current = [inner, { x: 3 }];
    const incoming = [{ x: 1, y: 2 }, { x: 4 }];
    const result = reconcile(current, incoming);
    expect(result).not.toBe(current);
    expect(result[0]).toBe(inner); // inner unchanged — same reference
    expect(result[1]).toEqual({ x: 4 }); // different value
  });

  // ── Objects ──

  test("preserves object reference when deeply equal", () => {
    const current = { a: 1, b: "two", c: true };
    const incoming = { a: 1, b: "two", c: true };
    expect(reconcile(current, incoming)).toBe(current);
  });

  test("returns incoming when key count differs", () => {
    const current = { a: 1 };
    const incoming = { a: 1, b: 2 };
    expect(reconcile(current, incoming)).toBe(incoming);
  });

  test("returns incoming when keys differ", () => {
    const current = { a: 1 } as Record<string, number>;
    const incoming = { b: 1 } as Record<string, number>;
    expect(reconcile(current, incoming)).toBe(incoming);
  });

  test("preserves unchanged nested objects", () => {
    const nested = { x: 1 };
    const current = { a: nested, b: 2 };
    const incoming = { a: { x: 1 }, b: 3 };
    const result = reconcile(current, incoming);
    expect(result).not.toBe(current);
    expect((result as Record<string, unknown>).a).toBe(nested); // unchanged subtree
    expect((result as Record<string, unknown>).b).toBe(3);
  });

  // ── Sets ──

  test("preserves Set reference when contents are equal", () => {
    const current = new Set([1, 2, 3]);
    const incoming = new Set([1, 2, 3]);
    expect(reconcile(current, incoming)).toBe(current);
  });

  test("returns new Set when contents differ", () => {
    const current = new Set([1, 2, 3]);
    const incoming = new Set([1, 2, 4]);
    const result = reconcile(current, incoming);
    expect(result).not.toBe(current);
    expect(result).toEqual(new Set([1, 2, 4]));
  });

  test("returns incoming Set when sizes differ", () => {
    const current = new Set([1, 2]);
    const incoming = new Set([1, 2, 3]);
    expect(reconcile(current, incoming)).toBe(incoming);
  });

  test("recursively reconciles Set elements (objects)", () => {
    const obj = { id: 1, name: "a" };
    const current = new Set([obj]);
    const incoming = new Set([{ id: 1, name: "a" }]);
    const result = reconcile(current, incoming) as Set<unknown>;
    expect(result).toBe(current); // deeply equal → same reference
  });

  // ── Maps ──

  test("preserves Map reference when entries are equal", () => {
    const current = new Map([
      ["a", 1],
      ["b", 2],
    ]);
    const incoming = new Map([
      ["a", 1],
      ["b", 2],
    ]);
    expect(reconcile(current, incoming)).toBe(current);
  });

  test("returns new Map when values differ", () => {
    const current = new Map([
      ["a", 1],
      ["b", 2],
    ]);
    const incoming = new Map([
      ["a", 1],
      ["b", 3],
    ]);
    const result = reconcile(current, incoming);
    expect(result).not.toBe(current);
    expect(result).toEqual(
      new Map([
        ["a", 1],
        ["b", 3],
      ]),
    );
  });

  test("returns incoming Map when sizes differ", () => {
    const current = new Map([["a", 1]]);
    const incoming = new Map([
      ["a", 1],
      ["b", 2],
    ]);
    expect(reconcile(current, incoming)).toBe(incoming);
  });

  test("returns incoming Map when keys differ", () => {
    const current = new Map([["a", 1]]);
    const incoming = new Map([["b", 1]]);
    expect(reconcile(current, incoming)).toBe(incoming);
  });

  test("recursively reconciles Map values", () => {
    const nested = { x: 1, y: [2, 3] };
    const current = new Map<string, unknown>([["key", nested]]);
    const incoming = new Map<string, unknown>([["key", { x: 1, y: [2, 3] }]]);
    const result = reconcile(current, incoming) as Map<string, unknown>;
    expect(result).toBe(current); // deeply equal → same reference
  });

  // ── Type mismatches ──

  test("returns incoming when types mismatch (array vs object)", () => {
    expect(reconcile([1, 2] as unknown, { 0: 1, 1: 2 })).toEqual({ 0: 1, 1: 2 });
    expect(reconcile({ a: 1 } as unknown, [1])).toEqual([1]);
  });

  test("returns incoming when Set vs array", () => {
    const arr = [1, 2];
    expect(reconcile(new Set([1, 2]) as unknown, arr)).toBe(arr);
  });

  // ── Deep nesting ──

  test("preserves references at every nesting level", () => {
    const deepInner = { z: 99 };
    const inner = { y: deepInner, w: [1, 2] };
    const current = { a: inner, b: "same" };
    const incoming = { a: { y: { z: 99 }, w: [1, 2] }, b: "same" };
    const result = reconcile(current, incoming);
    expect(result).toBe(current); // everything equal
    expect((result as Record<string, unknown>).a).toBe(inner);
    expect((inner as Record<string, unknown>).y).toBe(deepInner);
  });

  test("only replaces the changed subtree in deep nesting", () => {
    const unchanged = { x: 1 };
    const current = { a: unchanged, b: { c: { d: 1 } } };
    const incoming = { a: { x: 1 }, b: { c: { d: 2 } } };
    const result = reconcile(current, incoming) as Record<string, unknown>;
    expect(result).not.toBe(current);
    expect(result.a).toBe(unchanged); // preserved
    expect(result.b).not.toBe(current.b); // changed
    expect(result.b).toEqual({ c: { d: 2 } });
  });

  // ── Echo case ──

  test("echo: identical trees return current reference", () => {
    const state = {
      models: [{ id: "1", label: "test", provider: "openrouter", modelId: "m1", apiKey: "k1" }],
      codingAgent: { baseModelId: "1", functionOverrides: {} },
      layout: {
        zoneDefaults: { left: false, bottom: false, right: false },
        zonePanelOrder: { left: [], bottom: [], right: [] },
      },
      terminal: {
        scrollbackLines: 10000,
        notificationSequences: { osc9: true, osc777: true, osc99: true },
      },
      schemas: [],
    };
    const incoming = JSON.parse(JSON.stringify(state));
    expect(reconcile(state, incoming)).toBe(state);
  });

  // ── Same reference fast path ──

  test("returns current immediately for same reference", () => {
    const obj = { a: { b: { c: 1 } } };
    expect(reconcile(obj, obj)).toBe(obj);
  });
});
