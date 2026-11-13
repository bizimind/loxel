import { afterEach, describe, expect, jest, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HostLog } from "./host-log";
import type { HostLogMessage } from "./protocol";

const dirs: string[] = [];
afterEach(() => {
  jest.useRealTimers();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function createLog() {
  const dir = mkdtempSync(join(tmpdir(), "thlog-"));
  dirs.push(dir);
  const hostLog = new HostLog(join(dir, "terminal-host-abcdef01.log"));
  const forwarded: HostLogMessage[] = [];
  hostLog.setForward((message) => forwarded.push(message));
  return { hostLog, forwarded, log: hostLog.logger({ hostId: "abcdef01" }) };
}

describe("HostLog", () => {
  test("forwards info and above with their context, errors serialized; debug stays in the file", () => {
    const { log, forwarded, hostLog } = createLog();
    log.debug("noise");
    log.error("failed", { error: new Error("boom", { cause: new Error("root") }) });
    hostLog.close();
    expect(forwarded).toEqual([
      {
        type: "log",
        level: "error",
        msg: "failed",
        ctx: {
          hostId: "abcdef01",
          error: expect.objectContaining({
            message: "boom",
            cause: expect.objectContaining({ message: "root" }),
          }),
        },
      },
    ]);
  });

  test("forwards at most 50 lines a second, then says how many it held back", () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const { log, forwarded, hostLog } = createLog();
    for (let i = 0; i < 80; i++) log.info(`line ${i}`);
    expect(forwarded).toHaveLength(50);

    jest.setSystemTime(new Date("2026-01-01T00:00:01Z"));
    log.info("next second");
    hostLog.close();
    expect(forwarded.slice(50).map((message) => message.msg)).toEqual([
      expect.stringMatching(
        /^30 terminal host log lines were not forwarded; see .*terminal-host-abcdef01\.log$/,
      ),
      "next second",
    ]);
  });
});
