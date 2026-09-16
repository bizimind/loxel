import { describe, expect, test } from "bun:test";

import { describeError } from "./error-message";

/** Mimics a `Bun.$` ShellError: opaque message, real diagnostic on stderr. */
function shellError(exitCode: number, stderr: string): Error {
  const err = new Error(`Failed with exit code ${exitCode}`);
  return Object.assign(err, { stderr: new TextEncoder().encode(stderr) });
}

describe("describeError", () => {
  test("surfaces stderr alongside an opaque shell error message", () => {
    const message = describeError(
      shellError(255, "fatal: a branch named 'existing-br' already exists\n"),
      "fallback",
    );

    expect(message).toContain("fatal: a branch named 'existing-br' already exists");
    expect(message).toContain("Failed with exit code 255");
  });

  test("reads stderr from a wrapped cause", () => {
    const cause = shellError(128, "fatal: contains modified or untracked files");
    const message = describeError(new Error("Failed to remove worktree", { cause }), "fallback");

    expect(message).toBe(
      "Failed to remove worktree: Failed with exit code 128: fatal: contains modified or untracked files",
    );
  });

  test("accepts a string stderr", () => {
    const err = Object.assign(new Error("boom"), { stderr: "  detail  " });
    expect(describeError(err, "fallback")).toBe("boom: detail");
  });

  test("falls back when there is nothing to report", () => {
    expect(describeError(new Error(""), "fallback")).toBe("fallback");
    expect(describeError("not an error", "fallback")).toBe("fallback");
  });

  test("does not repeat an identical message and stderr", () => {
    const err = Object.assign(new Error("fatal: bad thing"), { stderr: "fatal: bad thing" });
    expect(describeError(err, "fallback")).toBe("fatal: bad thing");
  });
});
