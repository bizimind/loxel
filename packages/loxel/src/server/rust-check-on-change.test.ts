import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { CHECK_MAX_WAIT_MS, CHECK_QUIET_MS, RustCheckOnChange } from "./rust-check-on-change";

describe("RustCheckOnChange", () => {
  let wt: string;
  let saved: string[];
  let linked: Map<string, string>;
  let checks: RustCheckOnChange;

  beforeEach(async () => {
    wt = await realpath(await mkdtemp(join(tmpdir(), "rust-checks-")));
    saved = [];
    linked = new Map();
    checks = new RustCheckOnChange(wt, {
      linkedProjectOf: (file) => linked.get(dirname(file)) ?? null,
      save: (file) => saved.push(file),
    });
    jest.useFakeTimers();
  });

  afterEach(async () => {
    jest.useRealTimers();
    checks.dispose();
    await rm(wt, { recursive: true, force: true });
  });

  async function write(file: string, text = "fn a() {}"): Promise<string> {
    const full = join(wt, file);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, text);
    linked.set(dirname(full), "project");
    return full;
  }

  async function settle(): Promise<void> {
    jest.advanceTimersByTime(CHECK_MAX_WAIT_MS);
    await checks.idle();
  }

  test("waits for quiet, so a burst of writes costs one save", async () => {
    const file = await write("src/a.rs");
    checks.pathsChanged([file]);
    jest.advanceTimersByTime(CHECK_QUIET_MS - 1);
    await checks.idle();
    expect(saved).toEqual([]);
    checks.pathsChanged([file]);
    jest.advanceTimersByTime(CHECK_QUIET_MS - 1);
    await checks.idle();
    expect(saved).toEqual([]);
    jest.advanceTimersByTime(1);
    await checks.idle();
    expect(saved).toEqual([file]);
  });

  test("does not wait for quiet forever", async () => {
    const file = await write("src/a.rs");
    for (let waited = 0; waited < CHECK_MAX_WAIT_MS; waited += CHECK_QUIET_MS - 1) {
      checks.pathsChanged([file]);
      jest.advanceTimersByTime(CHECK_QUIET_MS - 1);
    }
    await checks.idle();
    expect(saved).toEqual([file]);
  });

  test("saves once per project, for each project changed", async () => {
    const a1 = await write("a/one.rs");
    const a2 = await write("a/two.rs");
    const b = await write("b/one.rs");
    linked.set(dirname(b), "other project");
    checks.pathsChanged([a1, a2, b]);
    await settle();
    expect(saved).toEqual([a1, b]);
  });

  test("ignores what is no Rust file, and a file no linked project holds", async () => {
    const file = await write("loose/a.rs");
    linked.clear();
    checks.pathsChanged([file, join(wt, "README.md")]);
    await settle();
    expect(saved).toEqual([]);
  });

  test("does not save for the same content again, as a build script writing sources would loop", async () => {
    const file = await write("src/gen.rs");
    checks.pathsChanged([file]);
    await settle();
    await write("src/gen.rs");
    checks.pathsChanged([file]);
    await settle();
    expect(saved).toEqual([file]);
    await write("src/gen.rs", "fn b() {}");
    checks.pathsChanged([file]);
    await settle();
    expect(saved).toEqual([file, file]);
  });

  test("counts a return to earlier content when a batch passed the file over", async () => {
    const a = await write("src/a.rs");
    const b = await write("src/b.rs");
    checks.pathsChanged([b]);
    await settle();
    await write("src/b.rs", "changed");
    checks.pathsChanged([a, b]);
    await settle();
    await write("src/b.rs");
    checks.pathsChanged([b]);
    await settle();
    expect(saved).toEqual([b, a, b]);
  });

  test("saves a neighbor for a deleted file, since the server knows only what exists", async () => {
    const near = await write("src/lib.rs");
    const gone = join(wt, "src/gone/old.rs");
    checks.pathsChanged([gone]);
    await settle();
    expect(saved).toEqual([near]);
  });

  test("saves nothing once disposed", async () => {
    const file = await write("src/a.rs");
    checks.pathsChanged([file]);
    checks.dispose();
    await settle();
    expect(saved).toEqual([]);
  });
});
