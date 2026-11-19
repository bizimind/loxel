/**
 * Downloads from browser panel pages: Electron's own Save dialog for each, at most one per page at
 * a time, and macOS's quarantine attribute on every downloaded file.
 *
 * Chromium on macOS quarantines downloads through a quarantine service that Electron doesn't give
 * it, so without this a downloaded app or script would open without Gatekeeper checking it.
 */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat } from "node:fs/promises";
import { promisify } from "node:util";

import type { DownloadItem, Session, WebContents } from "electron";

const execFileAsync = promisify(execFile);

const QUARANTINE_ATTRIBUTE = "com.apple.quarantine";
/** The flags macOS itself writes when an app quarantines a download (`NSURLQuarantinePropertiesKey`). */
const QUARANTINE_FLAGS = "0281";
/** The app that downloaded the file, as macOS records it. */
const QUARANTINE_AGENT = "Loxel";

/**
 * The `com.apple.quarantine` value macOS writes for a download: flags, the time in hex seconds, the
 * agent, and an event id. The download's URLs have no place in it: macOS keeps them in its
 * quarantine event database, keyed by that id, which only its own quarantine API writes.
 */
export function quarantineValue(now: Date, eventId: string = randomUUID().toUpperCase()): string {
  const seconds = Math.floor(now.getTime() / 1000).toString(16);
  return `${QUARANTINE_FLAGS};${seconds};${QUARANTINE_AGENT};${eventId}`;
}

/** Mark `path` as downloaded, so Gatekeeper checks it when it is opened (macOS only). */
export async function quarantineFile(path: string): Promise<void> {
  if (process.platform !== "darwin") return;
  // `-s`: a symbolic link itself, never the file it points to.
  await execFileAsync("/usr/bin/xattr", [
    "-s",
    "-w",
    QUARANTINE_ATTRIBUTE,
    quarantineValue(new Date()),
    path,
  ]);
}

/**
 * How much older than its download a file must look to be the user's own. File systems store
 * creation times coarsely (whole seconds on HFS+, two on FAT) or from another clock (SMB servers).
 */
const PREDATES_SLACK_MS = 60_000;

/**
 * Whether a file created at `birthtimeMs` provably was there before a download that started at
 * `startedMs`. A file system that records no creation time reports 0, which proves nothing.
 */
export function predatesDownload(birthtimeMs: number, startedMs: number): boolean {
  return birthtimeMs > 0 && birthtimeMs < startedMs - PREDATES_SLACK_MS;
}

/** The inode of the regular file (not a link) at `path`, with its creation time; null if none. */
async function regularFile(path: string): Promise<{ inode: bigint; birthtimeMs: number } | null> {
  const stats = await lstat(path, { bigint: true }).catch(() => null);
  if (!stats?.isFile()) return null;
  return { inode: stats.ino, birthtimeMs: Number(stats.birthtimeMs) };
}

/**
 * Keep `item`'s file quarantined from the moment it is at its save path. Electron has Chromium
 * write a download straight to the path the user picked, so marking it only once complete would
 * leave an unmarked file there for as long as the download runs, or for good if it stalls.
 * Progress can be reported before Chromium first moves its file there, so the path is checked
 * again on every report until a new file (inode) is there.
 *
 * A file at the path while the download runs may be the user's own: when they chose to replace
 * one, Chromium downloads beside it (`name (1).ext`) and moves the download onto the path only once
 * complete. So until then, a file that is provably older than the download is left alone; marking
 * is the default when that can't be told. Once complete, the regular file at the path is the
 * download, whatever its creation time says. A link at the path is never followed.
 */
export function trackQuarantine(item: DownloadItem, quarantine: (path: string) => Promise<void>) {
  const startedMs = item.getStartTime() * 1000;
  let complete = false;
  let markedInode: bigint | null = null;
  let running: Promise<void> | null = null;
  let again = false;

  const markIfNew = async (path: string) => {
    const file = await regularFile(path);
    if (!file || file.inode === markedInode) return;
    if (!complete && predatesDownload(file.birthtimeMs, startedMs)) return;
    await quarantine(path);
    markedInode = file.inode;
  };

  /**
   * Mark the file at the save path unless it is marked already. One check runs at a time; the
   * promise settles when this one (or the one running, which checks again after it) is done.
   */
  const update = (): Promise<void> => {
    const path = item.getSavePath();
    if (!path) return Promise.resolve();
    if (running) {
      again = true;
      return running;
    }
    running = markIfNew(path)
      .catch((err: unknown) => console.warn("[electron] Could not quarantine a download:", err))
      .finally(() => {
        running = null;
        if (again) {
          again = false;
          void update();
        }
      });
    return running;
  };
  return {
    update,
    /** Mark the completed download at the save path. */
    completed: () => {
      complete = true;
      return update();
    },
  };
}

/**
 * Handle `browserSession`'s downloads. A download Electron is still asking about (no save path yet)
 * keeps its page's later downloads from asking too: they are cancelled, so a page can't stack Save
 * dialogs.
 */
export function installBrowserDownloads(
  browserSession: Session,
  quarantine: (path: string) => Promise<void> = quarantineFile,
): void {
  /** Each page's download whose Save dialog is open. */
  const asking = new Map<WebContents, DownloadItem>();
  // Electron passes no webContents (despite its types) when the page that started the download is
  // gone, so there is no page to limit.
  browserSession.on("will-download", (event, item, contents: WebContents | null) => {
    if (contents && asking.has(contents)) {
      event.preventDefault();
      return;
    }
    // Electron shows its Save dialog after this event, unless a listener sets a path.
    if (contents) asking.set(contents, item);
    const answered = () => {
      if (contents && asking.get(contents) === item) asking.delete(contents);
    };
    const tracked = trackQuarantine(item, quarantine);
    // Progress arrives while the dialog is open too; a save path means it was answered.
    const onUpdated = () => {
      if (!item.getSavePath()) return;
      answered();
      void tracked.update();
    };
    item.on("updated", onUpdated);
    item.once("done", (_event, state) => {
      item.off("updated", onUpdated);
      answered();
      if (state === "completed") void tracked.completed();
    });
  });
}
