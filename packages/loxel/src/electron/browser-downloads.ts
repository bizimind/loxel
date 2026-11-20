/**
 * Downloads from browser panel pages: each goes straight to a free name in the Downloads folder,
 * with Loxel's own Save dialog beside it (at most one per page at a time), and macOS's quarantine
 * attribute on every downloaded file from the moment it is there.
 *
 * Chromium on macOS quarantines downloads through a quarantine service that Electron doesn't give
 * it, so without this a downloaded app or script would open without Gatekeeper checking it.
 *
 * Why a free name of Loxel's own: Electron downloads straight to the save path (no `.crdownload`),
 * and when a file is already there Chromium downloads to `name (1).ext` beside it instead, a path
 * the download never reports, so that file could not be marked until it was complete. A path picked
 * free (and kept from parallel downloads) is the one the bytes go to. Picking it in `will-download`
 * also replaces Electron's own dialog, during which Chromium writes to a hidden temporary file.
 */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync } from "node:fs";
import { constants, copyFile, link, lstat, rename, unlink } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { promisify } from "node:util";

import {
  app,
  BrowserWindow,
  dialog,
  type DownloadItem,
  type SaveDialogOptions,
  type Session,
  type WebContents,
} from "electron";

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

/**
 * Mark `path` as downloaded, so Gatekeeper checks it when it is opened (macOS only). A mark already
 * there is kept: Chromium's own, where it has its quarantine service, also records the download's
 * URLs.
 */
export async function quarantineFile(path: string): Promise<void> {
  if (process.platform !== "darwin") return;
  // `-s`: a symbolic link itself, never the file it points to.
  const marked = await execFileAsync("/usr/bin/xattr", [
    "-s",
    "-p",
    QUARANTINE_ATTRIBUTE,
    path,
  ]).then(
    () => true,
    () => false,
  );
  if (marked) return;
  await execFileAsync("/usr/bin/xattr", [
    "-s",
    "-w",
    QUARANTINE_ATTRIBUTE,
    quarantineValue(new Date()),
    path,
  ]);
}

/**
 * How much older than its download a file must look to be someone else's. File systems store
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
 * Keep `item`'s file quarantined from the moment it is at its save path. Chromium writes the
 * download straight to that path, so marking it only once complete would leave an unmarked file
 * there for as long as the download runs, or for good if it stalls. Progress can be reported before
 * Chromium first moves its file there, so the path is checked again on every report until a new
 * file (inode) is there.
 *
 * The path was free when the download started, but a file can land there before Chromium's does
 * (Chromium then downloads beside it). So until the download is complete, a file that is provably
 * older than the download is left alone; marking is the default when that can't be told. Once
 * complete, the regular file at the path is the download, whatever its creation time says. A link
 * at the path is never followed.
 */
export function trackQuarantine(item: DownloadItem, quarantine: (path: string) => Promise<void>) {
  const startedMs = item.getStartTime() * 1000;
  let complete = false;
  let markedInode: bigint | null = null;
  /** The last check asked for; checks run one after another. */
  let checks: Promise<void> = Promise.resolve();
  /** Whether the last check asked for has yet to start, so a new request can join it. */
  let checkWaiting = false;

  const markIfNew = async () => {
    const path = item.getSavePath();
    if (!path) return;
    const file = await regularFile(path);
    if (!file || file.inode === markedInode) return;
    if (!complete && predatesDownload(file.birthtimeMs, startedMs)) return;
    await quarantine(path);
    markedInode = file.inode;
  };

  /**
   * Mark the file at the save path unless it is marked already. Settles once a check that started
   * after this call is done: the waiting one it joins, or a new one after the one running.
   */
  const update = (): Promise<void> => {
    if (checkWaiting) return checks;
    checkWaiting = true;
    checks = checks.then(() => {
      checkWaiting = false;
      return markIfNew().catch((err: unknown) => {
        console.warn("[electron] Could not quarantine a download:", err);
      });
    });
    return checks;
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

function errorCode(err: unknown): unknown {
  return err instanceof Error && "code" in err ? err.code : undefined;
}

/** Whether nothing at all is at `path`, not even a dangling link. Throws if that can't be told. */
function nothingAt(path: string): boolean {
  return lstatSync(path, { throwIfNoEntry: false }) === undefined;
}

/**
 * Whether the user confirmed replacing what is at `path`: macOS's Save dialog asks before it
 * returns a path something is at. Not when that can't be told, so nothing is replaced unasked.
 */
function confirmedReplacing(path: string): boolean {
  try {
    return !nothingAt(path);
  } catch {
    return false;
  }
}

/** `name` numbered as Chrome numbers a download beside a file: `name (n).ext`, `a (n).tar.gz`. */
export function numberedName(name: string, n: number): string {
  if (n === 0) return name;
  const ext = /\.tar\.[^.]+$/i.exec(name)?.[0] ?? extname(name);
  return `${name.slice(0, name.length - ext.length)} (${n})${ext}`;
}

/** The first of `name`, `name (1)`, ... in `dir` that nothing is at and `taken` doesn't hold. */
export function freePath(dir: string, name: string, taken: ReadonlySet<string>): string {
  for (let n = 0; ; n++) {
    const path = join(dir, numberedName(name, n));
    if (!taken.has(path) && nothingAt(path)) return path;
  }
}

/** A file name a download may be saved under: Chromium's suggestion, never a path. */
function downloadFileName(item: DownloadItem): string {
  const name = basename(item.getFilename());
  return name === "" || name === "." || name === ".." ? "download" : name;
}

/** Move a new file to `to` without ever replacing what is there. */
async function moveToNew(from: string, to: string): Promise<void> {
  try {
    await link(from, to);
  } catch (err) {
    if (errorCode(err) === "EEXIST") throw err;
    // Another volume, or a file system without hard links.
    await copyFile(from, to, constants.COPYFILE_EXCL);
  }
  await unlink(from);
}

/** Move a file onto `to`, replacing what is there (a link itself, never what it points to). */
async function moveReplacing(from: string, to: string): Promise<void> {
  try {
    await rename(from, to);
    return;
  } catch (err) {
    if (errorCode(err) !== "EXDEV") throw err;
  }
  // Another volume: copy beside `to`, then swap it in.
  const copy = join(dirname(to), `.${basename(to)}.${randomUUID()}.download`);
  await copyFile(from, copy, constants.COPYFILE_EXCL);
  try {
    await rename(copy, to);
  } catch (err) {
    await unlink(copy).catch(() => {});
    throw err;
  }
  await unlink(from);
}

/**
 * Move a completed download to where the user chose, and return where it went. It replaces a file
 * there only when `replace` (the user confirmed it); otherwise a file that turned up there since
 * keeps it, and the download takes the next free number beside it.
 */
export async function moveDownload(from: string, to: string, replace: boolean): Promise<string> {
  if (replace) {
    await moveReplacing(from, to);
    return to;
  }
  for (let n = 0; ; n++) {
    const target = join(dirname(to), numberedName(basename(to), n));
    try {
      await moveToNew(from, target);
      return target;
    } catch (err) {
      if (errorCode(err) !== "EEXIST") throw err;
    }
  }
}

/** Where the user chose to save a download, and whether they confirmed replacing a file there. */
export interface SaveChoice {
  path: string;
  replace: boolean;
}

/**
 * Move the completed download at `savePath` to where the user chose, and mark it there again; or
 * remove it when they cancelled (`chosen` null). Only a regular file the download could have made
 * is moved or removed: a link, or a file provably older than the download, is left alone.
 */
export async function saveCompletedDownload(
  savePath: string,
  chosen: SaveChoice | null,
  startedMs: number,
  quarantine: (path: string) => Promise<void>,
): Promise<void> {
  if (chosen?.path === savePath) return;
  try {
    const file = await regularFile(savePath);
    if (!file || predatesDownload(file.birthtimeMs, startedMs)) return;
    if (chosen === null) {
      await unlink(savePath);
      return;
    }
    const moved = await moveDownload(savePath, chosen.path, chosen.replace);
    if (await regularFile(moved)) await quarantine(moved);
  } catch (err) {
    console.warn("[electron] Could not save a download where the user chose:", err);
  }
}

/** Ask where to save a download; null if the user cancelled. */
export type SaveAsPrompt = (
  contents: WebContents | null,
  options: SaveDialogOptions,
) => Promise<string | null>;

/** The Save dialog, attached to the window showing the page: a webview's host window, or the popup. */
const showSaveAs: SaveAsPrompt = async (contents, options) => {
  const shown = contents && !contents.isDestroyed() ? (contents.hostWebContents ?? contents) : null;
  const win = shown && !shown.isDestroyed() ? BrowserWindow.fromWebContents(shown) : null;
  const { canceled, filePath } = win
    ? await dialog.showSaveDialog(win, options)
    : await dialog.showSaveDialog(options);
  return canceled || !filePath ? null : filePath;
};

export interface BrowserDownloadsOptions {
  quarantine?: (path: string) => Promise<void>;
  saveAs?: SaveAsPrompt;
  /** The folder downloads go to until the user's choice; read for each download. */
  downloadsFolder?: () => string;
}

/**
 * Handle `browserSession`'s downloads. Each starts at once at a free name in the Downloads folder
 * while Loxel asks where to save it, and moves there once both are done; cancelling the dialog
 * cancels the download (or removes it, if complete). A page's download whose dialog is open keeps
 * its later downloads from asking too: they are cancelled, so a page can't stack Save dialogs.
 */
export function installBrowserDownloads(
  browserSession: Session,
  {
    quarantine = quarantineFile,
    saveAs = showSaveAs,
    downloadsFolder = () => app.getPath("downloads"),
  }: BrowserDownloadsOptions = {},
): void {
  /** Each page's download whose Save dialog is open. */
  const asking = new Map<WebContents, DownloadItem>();
  /** Save paths of downloads still running, which a file may not be at yet. */
  const reserved = new Set<string>();
  /** Where the user last saved a download, for the next dialog to start in. */
  let lastFolder: string | null = null;

  // Electron passes no webContents (despite its types) when the page that started the download is
  // gone, so there is no page to limit.
  browserSession.on("will-download", (event, item, contents: WebContents | null) => {
    if (contents && asking.has(contents)) {
      event.preventDefault();
      return;
    }
    const name = downloadFileName(item);
    let savePath: string;
    try {
      const folder = downloadsFolder();
      mkdirSync(folder, { recursive: true });
      savePath = freePath(folder, name, reserved);
    } catch (err) {
      console.warn("[electron] Could not pick a path for a download:", err);
      event.preventDefault();
      return;
    }
    // A path set during this event is where Chromium writes, and Electron shows no dialog.
    item.setSavePath(savePath);
    reserved.add(savePath);
    const startedMs = item.getStartTime() * 1000;

    const tracked = trackQuarantine(item, quarantine);
    const onUpdated = () => void tracked.update();
    item.on("updated", onUpdated);
    const finished = new Promise<{ state: string; marked: Promise<void> }>((resolve) => {
      item.once("done", (_event, state) => {
        item.off("updated", onUpdated);
        reserved.delete(savePath);
        resolve({ state, marked: state === "completed" ? tracked.completed() : Promise.resolve() });
      });
    });

    if (contents) asking.set(contents, item);
    const choice = saveAs(contents, { defaultPath: join(lastFolder ?? dirname(savePath), name) })
      .catch((err: unknown) => {
        console.warn("[electron] Could not ask where to save a download:", err);
        return null;
      })
      .then((path): SaveChoice | null => {
        if (contents && asking.get(contents) === item) asking.delete(contents);
        if (path === null) {
          if (item.getState() !== "completed") item.cancel();
          return null;
        }
        lastFolder = dirname(path);
        // Another running download's path isn't the user's to replace, though the dialog asked.
        return { path, replace: !reserved.has(path) && confirmedReplacing(path) };
      });

    void Promise.all([choice, finished]).then(async ([chosen, { state, marked }]) => {
      if (state !== "completed") return;
      await marked;
      await saveCompletedDownload(savePath, chosen, startedMs, quarantine);
    });
  });
}
