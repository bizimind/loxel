import { afterEach, describe, expect, test } from "bun:test";

import { localRef, localServerId } from "@/api/local-server";
import { toServerId, type WorktreeRef, worktreeRef } from "@/api/worktree-ref";
import type { WsMessage } from "@/api/ws-protocol";
import type { LspStopReason } from "@/lib/lsp-connection";

import { dispatchLoxelEvent } from "./loxel-events";
import { createToolchainServerRecovery } from "./toolchain-server-recovery";

const CHANGED = { type: "java_env_changed", wtPath: "/wt" } as const satisfies WsMessage;
const OTHER = toServerId("other-server");

let stop: () => void = () => {};
afterEach(() => stop());

/** What ws-bridge does with a toolchain's changed message that `server`'s socket delivered. */
function deliver(message: { type: string; wtPath: string }, server = localServerId()): void {
  dispatchLoxelEvent("loxel-toolchain-changed", {
    wt: worktreeRef(server, message.wtPath),
    changedMessage: message.type,
  });
}

function setup(reason: LspStopReason | null, activeWt: WorktreeRef | null = localRef("/wt")) {
  const calls: string[] = [];
  stop = createToolchainServerRecovery({
    changedMessage: CHANGED.type,
    client: {
      connect: (wt) => calls.push(`connect ${wt?.server}:${wt?.path}`),
      disconnect: () => calls.push("disconnect"),
    },
    stoppedServer: () => (reason ? { name: "Java", reason, detail: "" } : undefined),
    activeWorktree: () => activeWt,
  });
  return { calls, handle: deliver };
}

describe("createToolchainServerRecovery", () => {
  test("starts a server that could not start again from scratch", () => {
    const { calls, handle } = setup("start-failed");
    handle(CHANGED);
    expect(calls).toEqual(["disconnect", "connect test-server:/wt"]);
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
    const { calls, handle } = setup("start-failed", localRef("/other"));
    handle(CHANGED);
    expect(calls).toEqual([]);
  });

  test("ignores a change of the same path while a worktree of another server is active", () => {
    const { calls, handle } = setup("start-failed", worktreeRef(OTHER, "/wt"));
    handle(CHANGED);
    expect(calls).toEqual([]);
  });

  test("starts the server of another server's worktree on that server's change", () => {
    const { calls, handle } = setup("start-failed", worktreeRef(OTHER, "/wt"));
    handle(CHANGED, OTHER);
    expect(calls).toEqual(["disconnect", "connect other-server:/wt"]);
  });

  test("ignores other toolchains", () => {
    const { calls, handle } = setup("start-failed");
    handle({ type: "go_env_changed", wtPath: "/wt" });
    expect(calls).toEqual([]);
  });
});
