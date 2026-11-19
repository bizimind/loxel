import { describe, expect, spyOn, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { $ } from "bun";
import type { DownloadItem, Session, WebContents } from "electron";

import {
  installBrowserDownloads,
  predatesDownload,
  quarantineFile,
  quarantineValue,
  trackQuarantine,
} from "./browser-downloads";

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
});

/** A download whose Save dialog is open until `answer` or `finish`. */
class FakeDownload extends EventEmitter {
  savePath = "";
  /** Seconds since the epoch, as Electron reports it; files made in these tests are newer. */
  startTime = (Date.now() - 60_000) / 1000;
  answer(path: string) {
    this.savePath = path;
    this.progress();
  }
  progress() {
    this.emit("updated", {}, "progressing");
  }
  finish(state: "completed" | "cancelled" | "interrupted") {
    this.emit("done", {}, state);
  }
  getSavePath() {
    return this.savePath;
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

function setup() {
  const session = new EventEmitter();
  const fake = fakeQuarantine();
  installBrowserDownloads(session as unknown as Session, fake.quarantine);
  /** Start a download in `page`; whether it went ahead (was not cancelled). */
  const download = (page: WebContents | null, startTime?: number) => {
    const item = new FakeDownload();
    if (startTime !== undefined) item.startTime = startTime;
    let prevented = false;
    const event = { preventDefault: () => (prevented = true) };
    session.emit("will-download", event, item as unknown as DownloadItem, page);
    return { item, started: !prevented };
  };
  return { download, ...fake };
}

const page = () => ({}) as WebContents;

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

describe("installBrowserDownloads", () => {
  test("marks the file as soon as it is at its save path", () =>
    withDir(async (dir) => {
      const { download, calls, untilCalls } = setup();
      const file = join(dir, "tool.sh");
      const { item } = download(page());
      // The dialog was answered before Chromium moved its file there: nothing to mark yet.
      item.answer(file);
      await writeFile(file, "#!/bin/sh\n");
      item.progress();
      await untilCalls(1);
      item.finish("completed");
      expect(calls).toEqual([file]);
    }));

  test("retries a mark that failed", () =>
    withDir(async (dir) => {
      const warn = spyOn(console, "warn").mockImplementation(() => {});
      try {
        const { download, calls, untilCalls, failNext } = setup();
        const file = join(dir, "tool.sh");
        await writeFile(file, "#!/bin/sh\n");
        failNext();
        const { item } = download(page());
        item.answer(file);
        await untilCalls(1);
        item.finish("completed");
        await untilCalls(2);
        expect(calls).toEqual([file, file]);
      } finally {
        warn.mockRestore();
      }
    }));

  test("cancels a page's downloads while its Save dialog is open", () => {
    const { download } = setup();
    const tab = page();
    const first = download(tab).item;
    expect(download(tab).started).toBe(false);
    // Progress while the dialog is open doesn't answer it.
    first.progress();
    expect(download(tab).started).toBe(false);
    // Another page asks on its own.
    expect(download(page()).started).toBe(true);
    first.answer("/nonexistent/a.zip");
    expect(download(tab).started).toBe(true);
  });

  test("lets a page ask again once its dialog is dismissed", () => {
    const { download } = setup();
    const tab = page();
    download(tab).item.finish("cancelled");
    expect(download(tab).started).toBe(true);
  });

  test("an earlier download finishing keeps a later one's dialog counted", () => {
    const { download } = setup();
    const tab = page();
    const first = download(tab).item;
    first.answer("/nonexistent/a.zip");
    expect(download(tab).started).toBe(true);
    first.finish("completed");
    expect(download(tab).started).toBe(false);
  });

  test("doesn't limit downloads whose page is gone", () => {
    const { download } = setup();
    download(null);
    expect(download(null).started).toBe(true);
  });
});
