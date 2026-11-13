import { describe, expect, test } from "bun:test";

import { terminalEndMessage } from "./terminal-end-message";

describe("terminalEndMessage", () => {
  test("names the exit code, or says it exited when the code was lost", () => {
    expect(terminalEndMessage({ reason: "exited", exitCode: 1 })).toBe(
      "Process exited with code 1",
    );
    expect(terminalEndMessage({ reason: "exited", exitCode: null })).toBe("Process exited");
  });

  test("says a lost terminal host ended the terminal, with no exit code", () => {
    expect(terminalEndMessage({ reason: "host_lost" })).toBe(
      "Terminal ended: Loxel's terminal host stopped unexpectedly",
    );
  });
});
