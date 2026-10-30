import { beforeEach, describe, expect, test } from "bun:test";

import { drainSpawnStats, measureSpawn, recordSpawn } from "./spawn-metrics";

describe("spawn-metrics", () => {
  beforeEach(() => {
    drainSpawnStats();
  });

  test("summarises a window and starts the next one", () => {
    const start = performance.now();
    drainSpawnStats(start);

    recordSpawn("git status", 2, 40);
    recordSpawn("git status", 6, 20);
    recordSpawn("git log", 1, 100);

    const stats = drainSpawnStats(start + 10_000);
    expect(stats.windowMs).toBe(10_000);
    expect(stats.spawns).toBe(3);
    expect(stats.spawnsPerSec).toBe(0.3);
    expect(stats.blockMs).toEqual({ total: 9, max: 6 });
    expect(stats.childWallMs).toEqual({ total: 160, max: 100 });
    expect(stats.top).toEqual([
      { label: "git status", count: 2, blockMs: 8, wallMs: 60 },
      { label: "git log", count: 1, blockMs: 1, wallMs: 100 },
    ]);

    expect(drainSpawnStats(start + 20_000)).toMatchObject({ spawns: 0, top: [] });
  });

  test("keeps only the busiest labels", () => {
    for (let i = 0; i < 8; i++) {
      for (let n = 0; n <= i; n++) recordSpawn(`label-${i}`, 0);
    }
    const { top } = drainSpawnStats();
    expect(top.map((entry) => entry.label)).toEqual([
      "label-7",
      "label-6",
      "label-5",
      "label-4",
      "label-3",
    ]);
  });

  test("measureSpawn counts the call, returns its result and counts one that throws", () => {
    expect(measureSpawn("ok", () => 42)).toBe(42);
    expect(() =>
      measureSpawn("bad", () => {
        throw new Error("ENOENT");
      }),
    ).toThrow("ENOENT");
    expect(
      drainSpawnStats()
        .top.map((entry) => entry.label)
        .sort(),
    ).toEqual(["bad", "ok"]);
  });
});
