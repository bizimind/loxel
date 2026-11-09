import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FileMoveDetector } from "./file-move-detector";

let root: string;
let clock: number;
let detector: FileMoveDetector;

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "loxel-move-")));
  clock = 10_000;
  detector = new FileMoveDetector(root, () => clock);
  await mkdir(join(root, "src/lib"), { recursive: true });
  await writeFile(join(root, "src/a.ts"), "a");
  await writeFile(join(root, "src/lib/b.ts"), "b");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("FileMoveDetector", () => {
  test("reports a renamed tracked file as an external move", async () => {
    await detector.track("src/a.ts");
    await rename(join(root, "src/a.ts"), join(root, "src/renamed.ts"));

    expect(await detector.detect(["src/a.ts", "src/renamed.ts"], "external")).toEqual([
      { from: "src/a.ts", to: "src/renamed.ts", source: "external" },
    ]);
  });

  test("follows tracked files inside a moved directory", async () => {
    await detector.track("src/lib/b.ts");
    await mkdir(join(root, "pkg"));
    await rename(join(root, "src/lib"), join(root, "pkg/utils"));

    // A directory move is reported as the old and new directory, not the files inside.
    expect(await detector.detect(["src/lib", "pkg/utils"], "external")).toEqual([
      { from: "src/lib/b.ts", to: "pkg/utils/b.ts", source: "external" },
    ]);
  });

  test("keeps following the file after a move", async () => {
    await detector.track("src/a.ts");
    await rename(join(root, "src/a.ts"), join(root, "src/b.ts"));
    await detector.detect(["src/a.ts", "src/b.ts"], "external");
    await rename(join(root, "src/b.ts"), join(root, "src/c.ts"));

    expect(await detector.detect(["src/b.ts", "src/c.ts"], "external")).toEqual([
      { from: "src/b.ts", to: "src/c.ts", source: "external" },
    ]);
  });

  test("matches a move whose two events land in different passes", async () => {
    await detector.track("src/a.ts");
    await rename(join(root, "src/a.ts"), join(root, "src/later.ts"));

    expect(await detector.detect(["src/a.ts"], "external")).toEqual([]);
    clock += 500;
    expect(await detector.detect(["src/later.ts"], "external")).toEqual([
      { from: "src/a.ts", to: "src/later.ts", source: "external" },
    ]);
  });

  test("forgets a vanished file after the matching window", async () => {
    await detector.track("src/a.ts");
    await rename(join(root, "src/a.ts"), join(root, "src/late.ts"));
    await detector.detect(["src/a.ts"], "external");
    clock += 5_000;

    expect(await detector.detect(["src/late.ts"], "external")).toEqual([]);
  });

  test("reports an operation as active while it runs and briefly after it ends", () => {
    expect(detector.isOperationActive()).toBe(false);
    const end = detector.beginOperation();
    expect(detector.isOperationActive()).toBe(true);
    end();
    clock += 500;
    expect(detector.isOperationActive()).toBe(true);
    clock += 1_000;
    expect(detector.isOperationActive()).toBe(false);
  });

  test("labels moves with the source the caller sampled", async () => {
    await detector.track("src/a.ts");
    await rename(join(root, "src/a.ts"), join(root, "src/b.ts"));

    expect(await detector.detect(["src/a.ts", "src/b.ts"], "loxel")).toEqual([
      { from: "src/a.ts", to: "src/b.ts", source: "loxel" },
    ]);
  });

  test("follows a file renamed onto another tracked file", async () => {
    await detector.track("src/a.ts");
    await detector.track("src/lib/b.ts");
    await rename(join(root, "src/a.ts"), join(root, "src/lib/b.ts"));

    expect(await detector.detect(["src/a.ts", "src/lib/b.ts"], "external")).toEqual([
      { from: "src/a.ts", to: "src/lib/b.ts", source: "external" },
    ]);
  });

  test("follows a file two levels below a directory moved into a new parent", async () => {
    await mkdir(join(root, "src/lib/deep"));
    await writeFile(join(root, "src/lib/deep/c.ts"), "c");
    await detector.track("src/lib/deep/c.ts");
    await mkdir(join(root, "a/b"), { recursive: true });
    await rename(join(root, "src"), join(root, "a/b/src"));

    expect(await detector.detect(["src", "a/b/src"], "external")).toEqual([
      { from: "src/lib/deep/c.ts", to: "a/b/src/lib/deep/c.ts", source: "external" },
    ]);
  });

  test("never mistakes a symlink to the file for the file", async () => {
    await detector.track("src/a.ts");
    await rename(join(root, "src/a.ts"), join(root, "elsewhere.ts"));
    await symlink(join(root, "elsewhere.ts"), join(root, "src/link.ts"));

    expect(await detector.detect(["src/a.ts", "src/link.ts"], "external")).toEqual([]);
  });

  test("reports nothing for deletions, untracked files, or a file replaced in place", async () => {
    await detector.track("src/a.ts");
    await detector.track("src/lib/b.ts");

    // Atomic save: a new file renamed over the tracked name is still the same open file.
    await writeFile(join(root, "src/a.ts.tmp"), "a2");
    await rename(join(root, "src/a.ts.tmp"), join(root, "src/a.ts"));
    expect(await detector.detect(["src/a.ts", "src/a.ts.tmp"], "external")).toEqual([]);

    // The replacement's identity is now tracked, so renaming it is still followed.
    await rename(join(root, "src/a.ts"), join(root, "src/a2.ts"));
    expect(await detector.detect(["src/a.ts", "src/a2.ts"], "external")).toEqual([
      { from: "src/a.ts", to: "src/a2.ts", source: "external" },
    ]);

    await unlink(join(root, "src/lib/b.ts"));
    await writeFile(join(root, "src/other.ts"), "new file");
    expect(await detector.detect(["src/lib/b.ts", "src/other.ts"], "external")).toEqual([]);
  });

  test("does not report a copy-and-delete across files", async () => {
    await detector.track("src/a.ts");
    await writeFile(join(root, "src/copy.ts"), "a");
    await unlink(join(root, "src/a.ts"));

    expect(await detector.detect(["src/a.ts", "src/copy.ts"], "external")).toEqual([]);
  });
});
