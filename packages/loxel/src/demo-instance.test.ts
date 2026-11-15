import { describe, expect, test } from "bun:test";

import { demoPort, demoStateName, parseDemoInstance } from "./demo-instance";

describe("demo instances", () => {
  test("default to instance 0 on demo mode's port and state", () => {
    expect(parseDemoInstance(undefined)).toBe(0);
    expect(parseDemoInstance("")).toBe(0);
    expect(demoPort(0)).toBe(7435);
    expect(demoStateName(0)).toBe("loxel-demo");
  });

  test("give each instance its own port and state", () => {
    expect(parseDemoInstance("3")).toBe(3);
    expect(demoPort(3)).toBe(7438);
    expect(demoStateName(3)).toBe("loxel-demo-3");
  });

  test("refuse anything but a non-negative integer", () => {
    for (const bad of ["-1", "1.5", "abc", " 2"]) {
      expect(() => parseDemoInstance(bad)).toThrow("LOXEL_DEMO_INSTANCE");
    }
  });
});
