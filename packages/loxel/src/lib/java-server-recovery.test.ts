import { describe, expect, test } from "bun:test";

import type { WsMessage } from "@/api/ws-protocol";
import type { LspStopReason } from "@/lib/lsp-connection";

import { createJavaServerRecovery } from "./java-server-recovery";

const CHANGED = { type: "java_env_changed", wtPath: "/wt" } as const satisfies WsMessage;

function setup(reason: LspStopReason | null, activeWt: string | null = "/wt") {
  const calls: string[] = [];
  const handle = createJavaServerRecovery({
    client: {
      connect: (wtPath) => calls.push(`connect ${wtPath}`),
      disconnect: () => calls.push("disconnect"),
    },
    stoppedServer: () => (reason ? { name: "Java", reason, detail: "" } : undefined),
    activeWorktree: () => activeWt,
  });
  return { calls, handle };
}

describe("createJavaServerRecovery", () => {
  test("starts a server that could not start again from scratch", () => {
    const { calls, handle } = setup("start-failed");
    handle(CHANGED);
    expect(calls).toEqual(["disconnect", "connect /wt"]);
  });

  test.each(["replaced", "crashed", "unreachable"] as const)("leaves a server %s", (reason) => {
    const { calls, handle } = setup(reason);
    handle(CHANGED);
    expect(calls).toEqual([]);
  });

  test("leaves a server that is running", () => {
    const { calls, handle } = setup(null);
    handle(CHANGED);
    expect(calls).toEqual([]);
  });

  test("ignores another worktree's change", () => {
    const { calls, handle } = setup("start-failed", "/other");
    handle(CHANGED);
    expect(calls).toEqual([]);
  });

  test("ignores other toolchains", () => {
    const { calls, handle } = setup("start-failed");
    handle({ type: "go_env_changed", wtPath: "/wt" });
    expect(calls).toEqual([]);
  });
});
