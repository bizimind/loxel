import { describe, expect, test } from "bun:test";

import { terminalsForInstall, updateRestartsTerminals } from "./update-terminals";

describe("updateRestartsTerminals", () => {
  test("an update of the running hosts' major keeps the terminals, whatever its minor", () => {
    expect(updateRestartsTerminals("1.0.0", "1.1.0")).toBe(false);
    expect(updateRestartsTerminals("1.9.3", "1.1.0")).toBe(false);
  });

  test("an update of another major restarts them, up or down", () => {
    expect(updateRestartsTerminals("2.0.0", "1.1.0")).toBe(true);
    expect(updateRestartsTerminals("0.9.0", "1.1.0")).toBe(true);
  });

  test("an update that does not say, or says something unreadable, may restart them", () => {
    expect(updateRestartsTerminals(undefined, "1.1.0")).toBe("unknown");
    expect(updateRestartsTerminals("2", "1.1.0")).toBe("unknown");
  });

  test("compares with this build's protocol by default", () => {
    expect(updateRestartsTerminals("1.0.0")).toBe(false);
  });
});

describe("terminalsForInstall", () => {
  test("ends the terminals only for an update that restarts them", () => {
    expect(terminalsForInstall(true)).toBe("end");
    expect(terminalsForInstall(false)).toBe("keep");
    // The new server keeps what it can talk to and ends the rest, with a notice.
    expect(terminalsForInstall("unknown")).toBe("keep");
  });
});
