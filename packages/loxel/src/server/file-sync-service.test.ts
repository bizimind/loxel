import { afterEach, describe, expect, test } from "bun:test";
import { appendFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FilesSyncService } from "./file-sync-service";

let root: string | undefined;

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

describe("FilesSyncService pause/resume", () => {
  test("waits for an in-flight flush before reporting the watcher paused", async () => {
    let releaseFlush: (() => void) | undefined;
    let flushStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      flushStarted = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      releaseFlush = resolve;
    });
    let pauseFinished = false;
    const service = new FilesSyncService({
      recursive: false,
      debounceMs: 0,
      onFlush: async () => {
        flushStarted?.();
        await blocked;
      },
    });

    service.start();
    service.pushChange("file.txt");
    await started;
    const pausing = service.pause().then(() => {
      pauseFinished = true;
    });
    await Bun.sleep(5);
    expect(pauseFinished).toBe(false);

    releaseFlush?.();
    await pausing;
    service.stop();

    expect(pauseFinished).toBe(true);
  });

  test("resumes individual files without losing the tracked set", async () => {
    root = await mkdtemp(join(tmpdir(), "loxel-file-sync-"));
    const path = join(root, "external.txt");
    await Bun.write(path, "initial\n");
    const changes: string[] = [];
    const service = new FilesSyncService({
      recursive: false,
      debounceMs: 5,
      onFlush: (batch) => {
        changes.push(...batch.map((change) => change.key));
      },
    });

    service.start();
    service.watchFile(path);
    await service.pause();
    await appendFile(path, "while paused\n");
    await Bun.sleep(30);
    expect(changes).toEqual([]);

    await service.resume();
    for (let attempt = 0; attempt < 20 && changes.length === 0; attempt++) {
      await Bun.sleep(10);
    }
    service.stop();

    expect(changes).toContain(path);
  });

  test("requests a directory rescan for changes made while paused", async () => {
    root = await mkdtemp(join(tmpdir(), "loxel-file-sync-"));
    let rescans = 0;
    const service = new FilesSyncService({
      watchDir: root,
      recursive: false,
      debounceMs: 5,
      onFlush: () => {},
      onUnknownChange: () => {
        rescans++;
      },
    });

    service.start();
    await service.pause();
    await Bun.write(join(root, "created-while-paused"), "content");
    await service.resume();
    service.stop();

    expect(rescans).toBe(1);
  });

  test("delivers nonce-bearing writes made while a directory watcher is paused", async () => {
    root = await mkdtemp(join(tmpdir(), "loxel-file-sync-"));
    const batches: Array<{ key: string; nonces: string[] }> = [];
    const service = new FilesSyncService({
      watchDir: root,
      recursive: false,
      onFlush: (changes) => {
        batches.push(...changes);
      },
      onUnknownChange: () => {},
    });

    service.start();
    await service.pause();
    await service.writeWithNonce("saved.txt", "save-1", () =>
      Bun.write(join(root!, "saved.txt"), "content").then(() => {}),
    );
    await service.resume();
    service.stop();

    expect(batches).toEqual([{ key: "saved.txt", nonces: ["save-1"] }]);
  });
});
