/**
 * Downloads from browser panel pages: Electron's own Save dialog for each, at most one per page at
 * a time, and macOS's quarantine attribute on every downloaded file.
 *
 * Chromium on macOS quarantines downloads through a quarantine service that Electron doesn't give
 * it, so without this a downloaded app or script would open without Gatekeeper checking it.
 */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
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
  await execFileAsync("/usr/bin/xattr", [
    "-w",
    QUARANTINE_ATTRIBUTE,
    quarantineValue(new Date()),
    path,
  ]);
}

/**
 * Keep `item`'s file quarantined from the moment it is at its save path. Electron has Chromium
 * write a download straight to the path the user picked, so marking it only once complete would
 * leave an unmarked file there for as long as the download runs, or for good if it stalls.
 * Chromium moves its temporary file to that path after the dialog (replacing a file the user chose
 * to overwrite, and its attribute with it), and progress can be reported before the move, so the
 * file there is marked again whenever it is a different file (inode) from the one last marked.
 */
function trackQuarantine(item: DownloadItem, quarantine: (path: string) => Promise<void>) {
  let markedInode: bigint | null = null;
  let running: Promise<void> | null = null;
  let again = false;

  const markIfNew = async (path: string) => {
    const inode = await stat(path, { bigint: true }).then(
      (stats) => stats.ino,
      () => null,
    );
    if (inode === null || inode === markedInode) return;
    await quarantine(path);
    markedInode = inode;
  };

  /** Mark the file at the save path unless it is marked already; one check at a time. */
  const update = (): void => {
    const path = item.getSavePath();
    if (!path) return;
    if (running) {
      again = true;
      return;
    }
    running = markIfNew(path)
      .catch((err: unknown) => console.warn("[electron] Could not quarantine a download:", err))
      .finally(() => {
        running = null;
        if (again) {
          again = false;
          update();
        }
      });
  };
  return update;
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
    const updateQuarantine = trackQuarantine(item, quarantine);
    // Progress arrives while the dialog is open too; a save path means it was answered.
    const onUpdated = () => {
      if (!item.getSavePath()) return;
      answered();
      updateQuarantine();
    };
    item.on("updated", onUpdated);
    item.once("done", (_event, state) => {
      item.off("updated", onUpdated);
      answered();
      if (state === "completed") updateQuarantine();
    });
  });
}
