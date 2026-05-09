import { describe, expect, test } from "bun:test";

import { logger } from "./logger";

describe("logger.getSnapshotTotal", () => {
  test("excludes pending (unbroadcast) error delta so a subscribe mid-batch doesn't double-count", async () => {
    const before = logger.getSnapshotTotal();

    const child = logger.child("server");
    child.error("e1");
    child.error("e2");
    child.error("e3");

    // Broadcast hasn't fired yet (no broadcast callback registered + timer
    // runs at 100ms). Pending delta is 3; the snapshot must NOT include it,
    // otherwise a `subscribe_logs` that arrives in this window would deliver
    // those 3 errors twice: once in the snapshot, once in the subsequent
    // batched delta broadcast.
    expect(logger.getSnapshotTotal()).toBe(before);

    // Register a broadcast and wait past the batch window to let pending
    // delta flush. After the flush, the snapshot includes the errors.
    let broadcastDelta = 0;
    logger.setErrorCountBroadcast((delta) => {
      broadcastDelta += delta;
    });
    // Emitting one more schedules the timer; existing pending errors also
    // flush together.
    child.error("e4");
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 150);
    });

    expect(broadcastDelta).toBe(4);
    expect(logger.getSnapshotTotal()).toBe(before + 4);
  });
});
