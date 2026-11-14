import { describe, expect, test } from "bun:test";

import { terminalEndMessage } from "./terminal-end-message";

describe("terminalEndMessage", () => {
  test("names the exit code, or says it exited when the code was lost", () => {
    expect(terminalEndMessage({ reason: "exited", exitCode: 1, outputLost: false })).toBe(
      "Process exited with code 1",
    );
    expect(terminalEndMessage({ reason: "exited", exitCode: null, outputLost: false })).toBe(
      "Process exited",
    );
  });

  test("says when the output it printed while Loxel was away was not kept", () => {
    expect(terminalEndMessage({ reason: "exited", exitCode: 2, outputLost: true })).toBe(
      "Process exited with code 2 while Loxel was away; its last output was not kept",
    );
    expect(terminalEndMessage({ reason: "exited", exitCode: null, outputLost: true })).toBe(
      "Process exited while Loxel was away; its last output was not kept",
    );
  });

  test("says a lost terminal host ended the terminal, with no exit code", () => {
    expect(terminalEndMessage({ reason: "host_lost" })).toBe(
      "Terminal ended: Loxel's terminal host stopped unexpectedly",
    );
  });
});
