import { describe, test, expect } from "bun:test";

describe("test safety preload", () => {
  test("Bun.$ is blocked", () => {
    expect(() => Bun.$`echo hello`).toThrow("[TEST SAFETY] Bun.$");
  });

  test("Bun.spawn is blocked", () => {
    expect(() => Bun.spawn(["echo", "hello"])).toThrow("[TEST SAFETY] Bun.spawn");
  });

  test("Bun.write is blocked", () => {
    expect(() => Bun.write("/tmp/test", "data")).toThrow("[TEST SAFETY] Bun.write");
  });

  test("process.exit is blocked", () => {
    expect(() => process.exit(0)).toThrow("[TEST SAFETY] process.exit");
  });

  test("process.chdir is blocked", () => {
    expect(() => process.chdir("/tmp")).toThrow("[TEST SAFETY] process.chdir");
  });

  test("fs.mkdir is blocked", async () => {
    const fs = await import("node:fs/promises");
    expect(() => fs.mkdir("/tmp/test")).toThrow("[TEST SAFETY] fs.mkdir");
  });

  test("fs.writeFile is blocked", async () => {
    const fs = await import("node:fs/promises");
    expect(() => fs.writeFile("/tmp/test", "data")).toThrow("[TEST SAFETY] fs.writeFile");
  });

  test("default fs.writeFileSync is blocked", async () => {
    const fs = (await import("node:fs")).default;
    expect(() => fs.writeFileSync("/tmp/test", "data")).toThrow("[TEST SAFETY] fs.writeFileSync");
  });

  test("child_process.spawn is blocked", async () => {
    const cp = await import("node:child_process");
    expect(() => cp.spawn("echo", ["hello"])).toThrow("[TEST SAFETY] child_process.spawn");
  });

  test("default child_process.spawn is blocked", async () => {
    const cp = (await import("node:child_process")).default;
    expect(() => cp.spawn("echo", ["hello"])).toThrow("[TEST SAFETY] child_process.spawn");
  });
});
