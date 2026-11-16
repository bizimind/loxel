import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";

import { createResult } from "./result.ts";
import { runAction, runActionSync } from "./runner.ts";

let stdout: string[];
let stdoutSpy: ReturnType<typeof spyOn>;
let stderrSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  stdout = [];
  stdoutSpy = spyOn(process.stdout, "write").mockImplementation((chunk) => {
    stdout.push(String(chunk));
    return true;
  });
  // Nothing these tests run writes to stderr; capturing it keeps a regression's
  // stray output (like Bun's exit-code TypeError) out of the test log.
  stderrSpy = spyOn(process.stderr, "write").mockImplementation(() => true);
});

afterEach(() => {
  stdoutSpy.mockRestore();
  stderrSpy.mockRestore();
  process.exitCode = 0;
});

/** An Error carrying a `code`, like Node's fs errors or a parser's error class. */
function errorWithCode(message: string, code: unknown): Error {
  return Object.assign(new Error(message), { code });
}

const runners = {
  runAction: (opts: { json?: boolean }, err: unknown) =>
    runAction(opts, async () => {
      throw err;
    }),
  runActionSync: async (opts: { json?: boolean }, err: unknown) =>
    runActionSync(opts, () => {
      throw err;
    }),
};

describe.each(Object.entries(runners))("%s with a thrown error", (_name, run) => {
  test.each([
    ["a string code", "syntax"],
    ["a Node error code", "ENOENT"],
    ["no code", undefined],
    ["a zero code", 0],
    ["a fractional code", 1.5],
  ])("exits 1 for %s", async (_label, code) => {
    await run({}, errorWithCode("boom", code));
    expect(process.exitCode).toBe(1);
    expect(stdout.join("")).toBe("Error: boom\n");
  });

  test("uses a positive integer code as the exit code", async () => {
    await run({}, errorWithCode("boom", 3));
    expect(process.exitCode).toBe(3);
  });

  test("prints a clean JSON error object in --json mode", async () => {
    await run({ json: true }, errorWithCode("Parse error on line 2", "syntax"));
    expect(process.exitCode).toBe(1);
    expect(JSON.parse(stdout.join(""))).toEqual({ error: true, message: "Parse error on line 2" });
  });

  test("accepts non-Error throws", async () => {
    await run({}, "plain string");
    expect(process.exitCode).toBe(1);
    expect(stdout.join("")).toBe("Error: plain string\n");
  });
});

test("runAction uses the result's exit code on success", async () => {
  await runAction({ json: true }, async () => createResult({ ok: true }, () => "ok", 2));
  expect(process.exitCode).toBe(2);
  expect(JSON.parse(stdout.join(""))).toEqual({ ok: true });
});
