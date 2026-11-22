import { describe, expect, mock, spyOn, test } from "bun:test";
import { EventEmitter } from "node:events";
import { existsSync, rmSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { $ } from "bun";
import type { DownloadItem, Session, WebContents } from "electron";

import type { SaveAsPrompt } from "./browser-downloads";

// The module's Electron defaults (its Save dialog, the Downloads folder) are replaced in each test.
void mock.module("electron", () => ({ app: {}, BrowserWindow: {}, dialog: {} }));

const {
  freePath,
  ReservedPaths,
  installBrowserDownloads,
  moveDownload,
  numberedName,
  predatesDownload,
  quarantineFile,
  quarantineValue,
  saveCompletedDownload,
  stagingPath,
  trackQuarantine,
} = await import("./browser-downloads");

describe("quarantineValue", () => {
  test("is macOS's format: flags, hex seconds, agent, event id", () => {
    expect(quarantineValue(new Date(0x6a_ff_52_97 * 1000 + 999), "EVENT")).toBe(
      "0281;6aff5297;Loxel;EVENT",
    );
    expect(quarantineValue(new Date())).toMatch(/^0281;[0-9a-f]{8};Loxel;[0-9A-F-]{36}$/);
  });
});

describe.if(process.platform === "darwin")("quarantineFile", () => {
  test("sets the file's quarantine attribute", async () => {
    const dir = await mkdtemp(join(tmpdir(), "loxel-quarantine-"));
    try {
      const file = join(dir, "tool.sh");
      await writeFile(file, "#!/bin/sh\n");
      await quarantineFile(file);
      const value = await $`xattr -p com.apple.quarantine ${file}`.text();
      expect(value.trim()).toMatch(/^0281;[0-9a-f]{8};Loxel;[0-9A-F-]{36}$/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("keeps a quarantine attribute already there", async () => {
    const dir = await mkdtemp(join(tmpdir(), "loxel-quarantine-"));
    try {
      const file = join(dir, "tool.sh");
      await writeFile(file, "#!/bin/sh\n");
      const chromiums = "0083;6b00c416;Chrome;8F7C1A2E-0000-4000-8000-000000000000";
      await $`xattr -w com.apple.quarantine ${chromiums} ${file}`;
      await quarantineFile(file);
      expect((await $`xattr -p com.apple.quarantine ${file}`.text()).trim()).toBe(chromiums);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("gives a copy its original's quarantine attribute", () =>
    withDir(async (dir) => {
      const original = join(dir, "tool.sh");
      const copy = join(dir, "copy.sh");
      await writeFile(original, "#!/bin/sh\n");
      await writeFile(copy, "#!/bin/sh\n");
      const chromiums = "0083;6b00c416;Chrome;8F7C1A2E-0000-4000-8000-000000000000";
      await $`xattr -w com.apple.quarantine ${chromiums} ${original}`;
      await quarantineFile(copy, original);
      expect((await $`xattr -p com.apple.quarantine ${copy}`.text()).trim()).toBe(chromiums);
    }));

  test("keeps the mark on a download that completes before any progress event finds it", () =>
    withDir(async (dir) => {
      const session = new EventEmitter();
      const { shown, saveAs } = fakeSaveAs();
      const { calls, quarantine, untilCalls } = fakeQuarantine();
      installBrowserDownloads({
        quarantine: async (path, like) => {
          await quarantineFile(path, like);
          await quarantine(path);
        },
        saveAs,
        downloadsFolder: () => dir,
      })(session as unknown as Session);
      const item = new FakeDownload();
      session.emit("will-download", { preventDefault: () => {} }, item, page());
      // Chromium writes the whole file and marks it itself before Loxel hears of it.
      await writeFile(item.savePath, "#!/bin/sh\n");
      const chromiums = "0083;6b00c416;Chrome;8F7C1A2E-0000-4000-8000-000000000000";
      await $`xattr -w com.apple.quarantine ${chromiums} ${item.savePath}`;
      item.finish("completed");
      await untilCalls(1);
      expect((await $`xattr -p com.apple.quarantine ${item.savePath}`.text()).trim()).toBe(
        chromiums,
      );
      // And once moved where the user chose.
      const chosen = join(dir, "chosen.sh");
      shown[0]?.answer(chosen);
      await untilCalls(2);
      expect(calls).toEqual([item.savePath, chosen]);
      expect((await $`xattr -p com.apple.quarantine ${chosen}`.text()).trim()).toBe(chromiums);
    }));
});

/** A download as Chromium runs it: written to its save path on `progress`. */
class FakeDownload extends EventEmitter {
  savePath = "";
  filename = "tool.sh";
  state: "progressing" | "completed" | "cancelled" | "interrupted" = "progressing";
  /** Seconds since the epoch, as Electron reports it; files made in these tests are newer. */
  startTime = (Date.now() - 60_000) / 1000;
  async progress(content = "#!/bin/sh\n") {
    if (this.savePath) await writeFile(this.savePath, content);
    this.emit("updated", {}, "progressing");
  }
  finish(state: "completed" | "cancelled" | "interrupted") {
    this.state = state;
    this.emit("done", {}, state);
  }
  cancel() {
    if (this.state !== "progressing") return;
    // Chromium removes a cancelled download's file.
    if (this.savePath) rmSync(this.savePath, { force: true });
    this.finish("cancelled");
  }
  setSavePath(path: string) {
    this.savePath = path;
  }
  getSavePath() {
    return this.savePath;
  }
  getFilename() {
    return this.filename;
  }
  getState() {
    return this.state;
  }
  getStartTime() {
    return this.startTime;
  }
}

/** A `quarantine` that records its paths and fails once per queued `failures` entry. */
function fakeQuarantine() {
  const calls: string[] = [];
  const waiters: { count: number; resolve: () => void }[] = [];
  let failures = 0;
  const quarantine = async (path: string) => {
    calls.push(path);
    for (const waiter of waiters.filter((w) => calls.length >= w.count)) waiter.resolve();
    if (failures > 0) {
      failures--;
      throw new Error("xattr failed");
    }
  };
  /** Resolves once `count` calls were made. */
  const untilCalls = (count: number) =>
    new Promise<void>((resolve) => {
      if (calls.length >= count) resolve();
      else waiters.push({ count, resolve });
    });
  return { calls, quarantine, untilCalls, failNext: () => failures++ };
}

/** Save dialogs left open until the test answers them, in the order they were shown. */
function fakeSaveAs() {
  const shown: { defaultPath: string | undefined; answer: (path: string | null) => void }[] = [];
  const saveAs: SaveAsPrompt = (_contents, options) =>
    new Promise((resolve) => {
      shown.push({ defaultPath: options.defaultPath, answer: resolve });
    });
  return { shown, saveAs };
}

function setup(folder = "/nonexistent/Downloads") {
  const session = new EventEmitter();
  const fake = fakeQuarantine();
  const dialogs = fakeSaveAs();
  installBrowserDownloads({
    quarantine: fake.quarantine,
    saveAs: dialogs.saveAs,
    downloadsFolder: () => folder,
  })(session as unknown as Session);
  /** Start a download in `page`; whether it went ahead (was not cancelled). */
  const download = (page: WebContents | null, filename = "tool.sh") => {
    const item = new FakeDownload();
    item.filename = filename;
    let prevented = false;
    const event = { preventDefault: () => (prevented = true) };
    session.emit("will-download", event, item as unknown as DownloadItem, page);
    return { item, started: !prevented };
  };
  return { download, ...fake, ...dialogs };
}

const page = () => ({}) as WebContents;

/** Run everything already queued: the handlers of a dialog just answered. */
const settle = () =>
  new Promise<void>((resolve) => {
    setImmediate(resolve);
  });

async function withDir(run: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "loxel-downloads-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("predatesDownload", () => {
  const started = Date.UTC(2026, 10, 19, 12);
  test("only a file created well before the download started", () => {
    expect(predatesDownload(started - 2 * 60_000, started)).toBe(true);
    // Within a minute: coarse or skewed creation times can't tell.
    expect(predatesDownload(started - 30_000, started)).toBe(false);
    expect(predatesDownload(started + 1, started)).toBe(false);
    // No creation time recorded.
    expect(predatesDownload(0, started)).toBe(false);
  });
});

describe("trackQuarantine", () => {
  const ago = (ms: number) => (Date.now() - ms) / 1000;

  test("leaves an older file alone while the download runs, and marks it once complete", () =>
    withDir(async (dir) => {
      const { calls, quarantine } = fakeQuarantine();
      const file = join(dir, "tool.sh");
      await writeFile(file, "the user's own file");
      const item = new FakeDownload();
      // Started well after the file was made.
      item.startTime = ago(-5 * 60_000);
      item.savePath = file;
      const tracked = trackQuarantine(item as unknown as DownloadItem, quarantine);
      await tracked.update();
      expect(calls).toEqual([]);
      // Once complete, the file at the path is the download, whatever its creation time.
      await tracked.completed();
      expect(calls).toEqual([file]);
    }));

  test("marks a new file at the path once, and a different one again", () =>
    withDir(async (dir) => {
      const { calls, quarantine } = fakeQuarantine();
      const file = join(dir, "tool.sh");
      await writeFile(file, "#!/bin/sh\n");
      const item = new FakeDownload();
      item.savePath = file;
      const tracked = trackQuarantine(item as unknown as DownloadItem, quarantine);
      await tracked.update();
      await tracked.update();
      expect(calls).toEqual([file]);
      // Chromium moves a new file onto the path, made while the old one still exists (so with
      // another inode; one freed first can be reused at once).
      await writeFile(join(dir, "tool (1).sh"), "#!/bin/sh\n");
      await rename(join(dir, "tool (1).sh"), file);
      await tracked.completed();
      expect(calls).toEqual([file, file]);
    }));

  test("a request while a check runs settles only after a check that follows it", () =>
    withDir(async (dir) => {
      const file = join(dir, "tool.sh");
      await writeFile(file, "#!/bin/sh\n");
      const calls: string[] = [];
      let release = () => {};
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      let firstCall = () => {};
      const firstCalled = new Promise<void>((resolve) => {
        firstCall = resolve;
      });
      const quarantine = async (path: string) => {
        calls.push(path);
        if (calls.length === 1) {
          firstCall();
          await held;
        }
      };
      const item = new FakeDownload();
      item.savePath = file;
      const tracked = trackQuarantine(item as unknown as DownloadItem, quarantine);
      void tracked.update();
      await firstCalled;
      // While the first mark is still being written, the download completes onto the path.
      await writeFile(join(dir, "tool (1).sh"), "#!/bin/sh\n");
      await rename(join(dir, "tool (1).sh"), file);
      const completed = tracked.completed();
      release();
      await completed;
      expect(calls).toEqual([file, file]);
    }));

  test("never marks a link, or what it points to", () =>
    withDir(async (dir) => {
      const { calls, quarantine } = fakeQuarantine();
      const target = join(dir, "elsewhere.sh");
      await writeFile(target, "#!/bin/sh\n");
      const link = join(dir, "tool.sh");
      await symlink(target, link);
      const item = new FakeDownload();
      item.savePath = link;
      const tracked = trackQuarantine(item as unknown as DownloadItem, quarantine);
      await tracked.update();
      await tracked.completed();
      expect(calls).toEqual([]);
    }));
});

describe("numberedName", () => {
  test("numbers before the extension, as Chrome does", () => {
    expect(numberedName("tool.sh", 0)).toBe("tool.sh");
    expect(numberedName("tool.sh", 2)).toBe("tool (2).sh");
    expect(numberedName("archive.tar.gz", 1)).toBe("archive (1).tar.gz");
    expect(numberedName("image.svg.gz", 1)).toBe("image (1).svg.gz");
    expect(numberedName("script.user.js", 1)).toBe("script (1).user.js");
    // Only a known compression suffix after a short part is a double extension.
    expect(numberedName("notes.tar.foo", 1)).toBe("notes.tar (1).foo");
    expect(numberedName("db.backup.gz", 1)).toBe("db.backup (1).gz");
    expect(numberedName("README", 1)).toBe("README (1)");
  });

  test("cuts a name too long for the file system before its extension", () => {
    const bytes = (name: string) => Buffer.byteLength(name, "utf8");
    const long = `${"a".repeat(252)}.sh`;
    expect(numberedName(long, 0)).toBe(long);
    expect(numberedName(long, 1)).toBe(`${"a".repeat(248)} (1).sh`);
    expect(bytes(numberedName(`${"a".repeat(300)}.sh`, 0))).toBe(255);
    // Three-byte characters are cut whole.
    const cjk = numberedName(`${"文".repeat(90)}.txt`, 1);
    expect(cjk).toBe(`${"文".repeat(82)} (1).txt`);
    expect(bytes(cjk)).toBeLessThanOrEqual(255);
    // An extension that leaves no room is cut too.
    expect(bytes(numberedName(`a.${"b".repeat(300)}`, 2))).toBeLessThanOrEqual(255);
  });
});

describe("freePath", () => {
  test("skips files, dangling links and paths other downloads hold", () =>
    withDir(async (dir) => {
      await writeFile(join(dir, "tool.sh"), "the user's own file");
      await symlink(join(dir, "nowhere"), join(dir, "tool (1).sh"));
      const taken = new Set([join(dir, "tool (2).sh")]);
      expect(freePath(dir, "tool.sh", taken)).toBe(join(dir, "tool (3).sh"));
      expect(freePath(dir, "other.sh", taken)).toBe(join(dir, "other.sh"));
    }));

  test("takes reserved paths that differ only in case or normalization as one", () => {
    const reserved = new ReservedPaths();
    reserved.add("/Downloads/Tool.sh");
    reserved.add("/Downloads/caf\u00e9.txt");
    expect(freePath("/nonexistent", "tool.sh", reserved)).toBe("/nonexistent/tool.sh");
    expect(reserved.has("/Downloads/tool.SH")).toBe(true);
    expect(reserved.has("/Downloads/cafe\u0301.txt")).toBe(true);
    reserved.delete("/Downloads/TOOL.sh");
    expect(reserved.has("/Downloads/Tool.sh")).toBe(false);
  });
});

describe("moveDownload", () => {
  const noMark = async () => {};

  test("moves to a free path", () =>
    withDir(async (dir) => {
      const from = join(dir, "tool.sh");
      await writeFile(from, "download");
      await mkdir(join(dir, "elsewhere"));
      const to = join(dir, "elsewhere", "tool.sh");
      expect(await moveDownload(from, { path: to, replace: false }, noMark)).toBe(to);
      expect(await readFile(to, "utf8")).toBe("download");
      expect(existsSync(from)).toBe(false);
    }));

  test("keeps a file it wasn't told to replace, and takes the next number", () =>
    withDir(async (dir) => {
      const from = join(dir, "download.sh");
      await writeFile(from, "download");
      const to = join(dir, "tool.sh");
      await writeFile(to, "the user's own file");
      const target = join(dir, "elsewhere.sh");
      await writeFile(target, "a link's target");
      await symlink(target, join(dir, "tool (1).sh"));
      expect(await moveDownload(from, { path: to, replace: false }, noMark)).toBe(
        join(dir, "tool (2).sh"),
      );
      expect(await readFile(to, "utf8")).toBe("the user's own file");
      expect(await readFile(target, "utf8")).toBe("a link's target");
    }));

  test("replaces a file, or a link itself, when told to", () =>
    withDir(async (dir) => {
      const to = join(dir, "tool.sh");
      await writeFile(to, "the user's own file");
      await writeFile(join(dir, "a.sh"), "download");
      expect(await moveDownload(join(dir, "a.sh"), { path: to, replace: true }, noMark)).toBe(to);
      expect(await readFile(to, "utf8")).toBe("download");

      const target = join(dir, "elsewhere.sh");
      await writeFile(target, "a link's target");
      const link = join(dir, "link.sh");
      await symlink(target, link);
      await writeFile(join(dir, "b.sh"), "download");
      await moveDownload(join(dir, "b.sh"), { path: link, replace: true }, noMark);
      expect((await lstat(link)).isFile()).toBe(true);
      expect(await readFile(target, "utf8")).toBe("a link's target");
    }));
});

describe("stagingPath", () => {
  test("is a hidden name beside the target that fits the file system", () => {
    const bytes = (name: string) => Buffer.byteLength(name, "utf8");
    expect(stagingPath("/Volumes/Disk/tool.sh")).toMatch(
      /^\/Volumes\/Disk\/\.tool\.sh\.[0-9a-f-]{36}\.download$/,
    );
    for (const name of [`${"a".repeat(252)}.sh`, `${"文".repeat(83)}.sh`]) {
      const staged = basename(stagingPath(`/Volumes/Disk/${name}`));
      expect(staged.startsWith(".")).toBe(true);
      expect(bytes(staged)).toBeLessThanOrEqual(255);
    }
  });
});

describe("moveDownload numbering", () => {
  test("skips other downloads' paths, and stays put on its own", () =>
    withDir(async (dir) => {
      const noMark = async () => {};
      await writeFile(join(dir, "tool.sh"), "a running download");
      const from = join(dir, "tool (2).sh");
      await writeFile(from, "download");
      const taken = new Set([join(dir, "tool.sh"), join(dir, "tool (1).sh")]);
      const chosen = { path: join(dir, "tool.sh"), replace: false };
      expect(await moveDownload(from, chosen, noMark, taken)).toBe(from);
      expect(await readFile(from, "utf8")).toBe("download");
    }));
});

describe("saveCompletedDownload", () => {
  const startedMs = Date.now() - 60_000;

  test("moves the download where the user chose and marks it there", () =>
    withDir(async (dir) => {
      const { calls, quarantine } = fakeQuarantine();
      const from = join(dir, "tool.sh");
      await writeFile(from, "download");
      const to = join(dir, "chosen.sh");
      await saveCompletedDownload({
        savePath: from,
        chosen: { path: to, replace: false },
        startedMs,
        quarantine,
      });
      expect(await readFile(to, "utf8")).toBe("download");
      expect(calls).toEqual([to]);
    }));

  test("removes the download when the user cancelled", () =>
    withDir(async (dir) => {
      const { calls, quarantine } = fakeQuarantine();
      const from = join(dir, "tool.sh");
      await writeFile(from, "download");
      await saveCompletedDownload({ savePath: from, chosen: null, startedMs, quarantine });
      expect(existsSync(from)).toBe(false);
      expect(calls).toEqual([]);
    }));

  test("leaves a link or an older file at the save path alone", () =>
    withDir(async (dir) => {
      const { calls, quarantine } = fakeQuarantine();
      const older = join(dir, "older.sh");
      await writeFile(older, "the user's own file");
      // The download started well after the file was made.
      await saveCompletedDownload({
        savePath: older,
        chosen: null,
        startedMs: Date.now() + 5 * 60_000,
        quarantine,
      });
      expect(existsSync(older)).toBe(true);
      const link = join(dir, "link.sh");
      await symlink(older, link);
      await saveCompletedDownload({ savePath: link, chosen: null, startedMs, quarantine });
      expect(existsSync(link)).toBe(true);
      expect(calls).toEqual([]);
    }));
});

describe("installBrowserDownloads", () => {
  test("starts each download at a free name in the Downloads folder", () =>
    withDir(async (dir) => {
      const { download, shown } = setup(dir);
      await writeFile(join(dir, "tool.sh"), "the user's own file");
      const first = download(page()).item;
      const second = download(page()).item;
      // The dialog suggests a free name the download isn't at, so macOS doesn't ask to replace it.
      expect(shown.map((s) => s.defaultPath)).toEqual([
        join(dir, "tool (1).sh"),
        join(dir, "tool (1).sh"),
      ]);
      expect(first.getSavePath()).toBe(join(dir, "tool (2).sh"));
      // Before the first's file is there.
      expect(second.getSavePath()).toBe(join(dir, "tool (3).sh"));
      // Once a download is cancelled, its name is free again.
      second.cancel();
      expect(download(page()).item.getSavePath()).toBe(join(dir, "tool (3).sh"));
    }));

  test("a completed download keeps its path while its dialog is open", () =>
    withDir(async (dir) => {
      const { download, shown, untilCalls } = setup(dir);
      const first = download(page()).item;
      await first.progress("first");
      first.finish("completed");
      await untilCalls(1);
      const second = download(page()).item;
      expect(second.getSavePath()).not.toBe(first.getSavePath());
      // Choosing the first's file in the second's dialog doesn't replace it.
      shown[1]?.answer(first.getSavePath());
      await second.progress("second");
      second.finish("completed");
      await untilCalls(3);
      expect(await readFile(first.getSavePath(), "utf8")).toBe("first");
    }));

  test("starts a download whose name is as long as the file system takes", () =>
    withDir(async (dir) => {
      const { download, shown } = setup(dir);
      const long = `${"文".repeat(83)}.sh`;
      const { item, started } = download(page(), long);
      expect(started).toBe(true);
      expect(shown[0]?.defaultPath).toBe(join(dir, long));
      await item.progress();
      expect(existsSync(item.savePath)).toBe(true);
    }));

  test("a download that ended unfinished leaves another's hold on its path alone", () =>
    withDir(async (dir) => {
      const { download, shown } = setup(dir);
      const first = download(page()).item;
      first.finish("interrupted");
      const second = download(page()).item;
      expect(second.getSavePath()).toBe(first.getSavePath());
      // The first's dialog, answered late.
      shown[0]?.answer(null);
      await settle();
      expect(download(page()).item.getSavePath()).not.toBe(second.getSavePath());
    }));

  test("the next dialog starts in the folder last saved to", () =>
    withDir(async (dir) => {
      const { download, shown } = setup(dir);
      download(page());
      shown[0]?.answer(join(dir, "elsewhere", "saved.sh"));
      await settle();
      download(page());
      expect(shown[1]?.defaultPath).toBe(join(dir, "elsewhere", "tool.sh"));
    }));

  test("cancels a download it can't pick a path for", () =>
    withDir(async (dir) => {
      const warn = spyOn(console, "warn").mockImplementation(() => {});
      try {
        const notAFolder = join(dir, "file");
        await writeFile(notAFolder, "");
        expect(setup(notAFolder).download(page()).started).toBe(false);
      } finally {
        warn.mockRestore();
      }
    }));

  test("marks the file as soon as it is at its save path", () =>
    withDir(async (dir) => {
      const { download, calls, untilCalls } = setup(dir);
      const { item } = download(page());
      await item.progress();
      await untilCalls(1);
      expect(calls).toEqual([item.savePath]);
    }));

  test("retries a mark that failed", () =>
    withDir(async (dir) => {
      const warn = spyOn(console, "warn").mockImplementation(() => {});
      try {
        const { download, calls, untilCalls, failNext } = setup(dir);
        failNext();
        const { item } = download(page());
        await item.progress();
        await untilCalls(1);
        item.finish("completed");
        await untilCalls(2);
        expect(calls).toEqual([item.savePath, item.savePath]);
      } finally {
        warn.mockRestore();
      }
    }));

  test("moves the completed download where the user chose, whichever is done first", () =>
    withDir(async (dir) => {
      const { download, shown, calls, untilCalls } = setup(dir);
      await mkdir(join(dir, "elsewhere"));
      const early = download(page()).item;
      await early.progress("early");
      await untilCalls(1);
      shown[0]?.answer(join(dir, "elsewhere", "early.sh"));
      early.finish("completed");
      // Marked again once moved.
      await untilCalls(2);
      expect(await readFile(join(dir, "elsewhere", "early.sh"), "utf8")).toBe("early");
      expect(existsSync(early.savePath)).toBe(false);

      const late = download(page()).item;
      await late.progress("late");
      await untilCalls(3);
      late.finish("completed");
      shown[1]?.answer(join(dir, "elsewhere", "late.sh"));
      await untilCalls(4);
      expect(await readFile(join(dir, "elsewhere", "late.sh"), "utf8")).toBe("late");
      expect(calls.at(-1)).toBe(join(dir, "elsewhere", "late.sh"));
    }));

  test("replaces a file only when the user chose it in the dialog", () =>
    withDir(async (dir) => {
      const { download, shown, untilCalls } = setup(dir);
      const chosen = join(dir, "chosen.sh");
      await writeFile(chosen, "the user's own file");
      const replacing = download(page()).item;
      shown[0]?.answer(chosen);
      await replacing.progress("replacing");
      replacing.finish("completed");
      await untilCalls(2);
      expect(await readFile(chosen, "utf8")).toBe("replacing");

      // A file that turns up after the user chose keeps its place.
      const other = join(dir, "other.sh");
      const keeping = download(page()).item;
      shown[1]?.answer(other);
      // Only once the answer is in: then nothing was there to confirm replacing.
      await settle();
      await writeFile(other, "made since");
      await keeping.progress("keeping");
      keeping.finish("completed");
      await untilCalls(4);
      expect(await readFile(other, "utf8")).toBe("made since");
      expect(await readFile(join(dir, "other (1).sh"), "utf8")).toBe("keeping");
    }));

  test("cancelling the dialog cancels the download", () =>
    withDir(async (dir) => {
      const { download, shown } = setup(dir);
      const { item } = download(page());
      await item.progress();
      shown[0]?.answer(null);
      await settle();
      expect(item.state).toBe("cancelled");
      expect(existsSync(item.savePath)).toBe(false);
    }));

  test("cancels a page's downloads while its Save dialog is open", () =>
    withDir(async (dir) => {
      const { download, shown } = setup(dir);
      const tab = page();
      const first = download(tab).item;
      expect(download(tab).started).toBe(false);
      // Progress while the dialog is open doesn't answer it.
      await first.progress();
      expect(download(tab).started).toBe(false);
      // Another page asks on its own.
      expect(download(page()).started).toBe(true);
      shown[0]?.answer(join(dir, "a.sh"));
      await settle();
      expect(download(tab).started).toBe(true);
    }));

  test("lets a page ask again once its dialog is dismissed", () =>
    withDir(async (dir) => {
      const { download, shown } = setup(dir);
      const tab = page();
      download(tab);
      shown[0]?.answer(null);
      await settle();
      expect(download(tab).started).toBe(true);
    }));

  test("doesn't limit downloads whose page is gone", () =>
    withDir(async (dir) => {
      const { download } = setup(dir);
      download(null);
      expect(download(null).started).toBe(true);
    }));
});
