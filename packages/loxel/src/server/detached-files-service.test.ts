import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DetachedFilesService } from "./detached-files-service";

let dir: string;
let service: DetachedFilesService | null = null;

beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), "loxel-detached-")));
});

afterEach(async () => {
  service?.stop();
  service = null;
  await rm(dir, { recursive: true, force: true });
});

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for condition");
    await Bun.sleep(20);
  }
}

describe("DetachedFilesService content events", () => {
  test("fires file-changed for a deleted draft and again when it is re-created", async () => {
    const file = join(dir, "note.md");
    await writeFile(file, "hello");
    const changed: string[] = [];
    service = new DetachedFilesService(
      dir,
      () => {},
      (path) => changed.push(path),
    );
    await service.start();
    // FSEvents needs a moment before it reports changes for a freshly watched directory.
    await Bun.sleep(200);

    await unlink(file);
    await waitFor(() => changed.length >= 1);
    expect(changed).toContain(file);

    changed.length = 0;
    await writeFile(file, "back");
    await waitFor(() => changed.length >= 1);
    expect(changed).toContain(file);
  });
});
