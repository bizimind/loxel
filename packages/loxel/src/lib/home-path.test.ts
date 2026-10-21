import { describe, expect, test } from "bun:test";

import { abbreviateHomePath } from "./home-path";

describe("abbreviateHomePath", () => {
  test("replaces the home prefix with ~", () => {
    expect(abbreviateHomePath("/Users/me/git/app", "/Users/me")).toBe("~/git/app");
  });

  test("abbreviates the home directory itself", () => {
    expect(abbreviateHomePath("/Users/me", "/Users/me")).toBe("~");
  });

  test("accepts a home directory with a trailing slash", () => {
    expect(abbreviateHomePath("/Users/me/git/app", "/Users/me/")).toBe("~/git/app");
  });

  test("leaves paths outside home unchanged", () => {
    expect(abbreviateHomePath("/opt/app", "/Users/me")).toBe("/opt/app");
  });

  test("does not match a sibling directory sharing the home prefix", () => {
    expect(abbreviateHomePath("/Users/meg/app", "/Users/me")).toBe("/Users/meg/app");
  });

  test("leaves paths unchanged when home is unknown or the root", () => {
    expect(abbreviateHomePath("/Users/me/app", null)).toBe("/Users/me/app");
    expect(abbreviateHomePath("/app", "/")).toBe("/app");
  });
});
