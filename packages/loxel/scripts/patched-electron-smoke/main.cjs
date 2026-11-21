/**
 * The Electron side of `scripts/patched-electron-smoke.ts`: checks, on a patched Electron build,
 * each behavior Loxel takes from its patches (docs/PATCHED_ELECTRON.md), and prints one
 * `SMOKE {name, ok, detail}` line per check, then `SMOKE_DONE`. Its windows are never seen: shown
 * inactive at zero opacity and ignoring the mouse, as Loxel's hidden demo does, with no Dock icon.
 * The runner passes the servers' URLs in SMOKE_CONFIG.
 */
const { execFileSync } = require("node:child_process");
const events = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");

const { BrowserWindow, app, session } = require("electron");

/** @type {{ page: string, publicPage: string, lanPage: string | null, target: string, targetCount: string, download: string }} */
const config = JSON.parse(process.env.SMOKE_CONFIG ?? "{}");
/** How long clicking the `<usermedia>` element may take to reach the handlers before it fails. */
const NO_ANSWER_MS = 10_000;
const CLICK_INTERVAL_MS = 250;
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "loxel-patched-electron-smoke-"));

function report(name, ok, detail = "") {
  console.log(`SMOKE ${JSON.stringify({ name, ok, detail })}`);
}

/** The value of extended attribute `name` on `file`, or null when it has none. */
function xattr(file, name) {
  try {
    return execFileSync("/usr/bin/xattr", ["-p", name, file], { stdio: "pipe" }).toString().trim();
  } catch {
    return null;
  }
}

/** A window nobody sees, in its own session, loaded on `url`. */
async function hiddenWindow(url, { partition, webPreferences = {} } = {}) {
  const win = new BrowserWindow({
    show: false,
    opacity: 0,
    width: 800,
    height: 600,
    webPreferences: { partition, backgroundThrottling: false, ...webPreferences },
  });
  win.setIgnoreMouseEvents(true);
  win.showInactive();
  await win.loadURL(url);
  return win;
}

/** Run `code` in the page as if from a click, so APIs that need a user gesture accept it. */
const withGesture = (win, code) => win.webContents.mainFrame.executeJavaScript(code, true);

/** Drop `file` on the page, which keeps its File System Access handle as `window.handle`. */
async function dropOnPage(win, file) {
  await win.webContents.executeJavaScript(`
    window.dropped = new Promise((resolve, reject) => {
      document.addEventListener("dragover", (event) => event.preventDefault());
      document.addEventListener("drop", (event) => {
        event.preventDefault();
        event.dataTransfer.items[0].getAsFileSystemHandle().then((handle) => {
          window.handle = handle;
          resolve(handle.kind);
        }, reject);
      }, { once: true });
    });
    null`);
  const { debugger: cdp } = win.webContents;
  cdp.attach("1.3");
  const data = { items: [], files: [file], dragOperationsMask: 1 };
  for (const type of ["dragEnter", "dragOver", "drop"]) {
    await cdp.sendCommand("Input.dispatchDragEvent", { type, x: 100, y: 100, data });
  }
  cdp.detach();
  return win.webContents.executeJavaScript("window.dropped");
}

/** File System Access requests a session's request handler sees, which it answers with `grant`. */
function fileSystemSession(partition, grant) {
  const ses = session.fromPartition(partition);
  const requests = [];
  // As Loxel does: the check keeps whatever access was granted (patch 0005 makes it a veto).
  ses.setPermissionCheckHandler((_contents, permission) => permission === "fileSystem");
  ses.setPermissionRequestHandler((_contents, permission, callback, details) => {
    if (permission === "fileSystem") requests.push(details);
    callback(permission === "fileSystem" && grant);
  });
  return requests;
}

async function fileOpenedForReadingAsksBeforeWrite() {
  const file = path.join(scratch, "read-only.txt");
  fs.writeFileSync(file, "original");
  const requests = fileSystemSession("smoke-fsa-read", false);
  const win = await hiddenWindow(config.page, { partition: "smoke-fsa-read" });
  try {
    await dropOnPage(win, file);
    const status = await win.webContents.executeJavaScript(
      'window.handle.queryPermission({ mode: "readwrite" })',
    );
    const error = await withGesture(
      win,
      "window.handle.createWritable().then(() => null, (error) => error.name)",
    );
    const asked = requests.some((r) => r.filePath === file && r.fileAccessType === "writable");
    const unchanged = fs.readFileSync(file, "utf8") === "original";
    report(
      "0005 a file dropped for reading asks the request handler before it is written",
      status === "prompt" && error === "NotAllowedError" && asked && unchanged,
      `readwrite=${status}, createWritable=${error ?? "ok"}, asked=${asked}, unchanged=${unchanged}`,
    );
  } finally {
    win.destroy();
  }
}

async function fileSavedBySiteIsQuarantined() {
  const dir = fs.mkdtempSync(path.join(scratch, "folder-"));
  fileSystemSession("smoke-fsa-save", true);
  const win = await hiddenWindow(config.page, { partition: "smoke-fsa-save" });
  try {
    await dropOnPage(win, dir);
    const status = await withGesture(
      win,
      `(async () => {
        const status = await window.handle.requestPermission({ mode: "readwrite" });
        const file = await window.handle.getFileHandle("saved.txt", { create: true });
        const writable = await file.createWritable();
        await writable.write("saved by the page");
        await writable.close();
        return status;
      })()`,
    );
    const quarantine = xattr(path.join(dir, "saved.txt"), "com.apple.quarantine");
    report(
      "0006 a file a page saves gets com.apple.quarantine",
      status === "granted" && quarantine !== null,
      `requestPermission=${status}, com.apple.quarantine=${quarantine ?? "none"}`,
    );
  } finally {
    win.destroy();
  }
}

async function downloadIsQuarantined() {
  const ses = session.fromPartition("smoke-download");
  const file = path.join(scratch, "downloaded.bin");
  const item = events.once(ses, "will-download").then(([, downloadItem]) => {
    downloadItem.setSavePath(file);
    return events.once(downloadItem, "done");
  });
  ses.downloadURL(config.download);
  const [, state] = await item;
  const quarantine = xattr(file, "com.apple.quarantine");
  const whereFroms = xattr(file, "com.apple.metadata:kMDItemWhereFroms");
  report(
    "0006 a completed download gets com.apple.quarantine with its source",
    state === "completed" && quarantine !== null && whereFroms !== null,
    `state=${state}, com.apple.quarantine=${quarantine ?? "none"}, kMDItemWhereFroms=${whereFroms === null ? "none" : "set"}`,
  );
}

/** Requests the target server has had, as it counts them. */
async function targetRequests() {
  return Number(await (await fetch(config.targetCount)).text());
}

/** From a page on `url`: whether its fetch of the local target worked, and the network checks. */
async function fetchTargetFrom(url, partition, allow) {
  const ses = session.fromPartition(partition);
  const checks = [];
  ses.setPermissionCheckHandler((_contents, permission) => {
    if (!permission.endsWith("network") && permission !== "local-network-access") return false;
    checks.push(permission);
    return allow;
  });
  const win = await hiddenWindow(url, { partition });
  try {
    const before = await targetRequests();
    const fetched = await win.webContents.executeJavaScript(
      `fetch(${JSON.stringify(config.target)}).then(() => true, () => false)`,
    );
    return { fetched, checks, sent: (await targetRequests()) - before };
  } finally {
    win.destroy();
  }
}

async function localNetworkAccess() {
  const refused = await fetchTargetFrom(config.publicPage, "smoke-lna-public", false);
  report(
    "0007 a public page reaching this machine is refused before anything is sent",
    !refused.fetched && refused.checks.includes("loopback-network") && refused.sent === 0,
    `fetched=${refused.fetched}, checks=${refused.checks.join(",") || "none"}, requests sent=${refused.sent}`,
  );
  const allowed = await fetchTargetFrom(config.publicPage, "smoke-lna-allowed", true);
  report(
    "0007 an allowed public page reaches this machine",
    allowed.fetched && allowed.sent === 1,
    `fetched=${allowed.fetched}, requests sent=${allowed.sent}`,
  );
  const pages = [["a localhost dev page", config.page]];
  if (config.lanPage) pages.push(["a LAN-address dev page", config.lanPage]);
  else
    report(
      "0007 a LAN-address dev page reaches another local port",
      true,
      "skipped: no LAN address",
    );
  for (const [index, [name, url]] of pages.entries()) {
    const result = await fetchTargetFrom(url, `smoke-lna-dev-${index}`, false);
    report(
      `0007 ${name} reaches another local port without a check`,
      result.fetched && result.checks.length === 0 && result.sent === 1,
      `fetched=${result.fetched}, checks=${result.checks.join(",") || "none"}, requests sent=${result.sent}`,
    );
  }
}

async function exitExclusiveAccess() {
  // The page's fullscreen doesn't resize the window, so the window stays unseen.
  const webPreferences = { disableHtmlFullscreenWindowResize: true };
  const win = await hiddenWindow(config.page, { partition: "smoke-exclusive", webPreferences });
  try {
    if (typeof win.webContents.exitExclusiveAccess !== "function") {
      report("0008 exitExclusiveAccess() ends HTML fullscreen", false, "no such method");
      return;
    }
    let left = false;
    win.webContents.on("leave-html-full-screen", () => {
      left = true;
    });
    win.webContents.exitExclusiveAccess();
    await win.webContents.executeJavaScript("null");
    report("0008 exitExclusiveAccess() does nothing when nothing is held", !left, `left=${left}`);

    const entered = events.once(win.webContents, "enter-html-full-screen");
    await withGesture(
      win,
      'new Promise((resolve) => { document.addEventListener("fullscreenchange", resolve, { once: true }); document.body.requestFullscreen(); })',
    );
    await entered;
    await win.webContents.executeJavaScript(
      'window.pageLeft = new Promise((resolve) => document.addEventListener("fullscreenchange", () => resolve(document.fullscreenElement), { once: true })); null',
    );
    const leaving = events.once(win.webContents, "leave-html-full-screen");
    win.webContents.exitExclusiveAccess();
    await leaving;
    const element = await win.webContents.executeJavaScript("window.pageLeft");
    report(
      "0008 exitExclusiveAccess() ends HTML fullscreen",
      element === null,
      `fullscreenElement=${element}`,
    );
  } finally {
    win.destroy();
  }
}

async function userMediaElement() {
  const ses = session.fromPartition("smoke-usermedia");
  const events = [];
  ses.setPermissionCheckHandler((_contents, permission, _origin, details) => {
    if (permission === "media") events.push(`check:${details.mediaType}`);
    return false;
  });
  const requested = new Promise((resolve) => {
    // Refused, so no device is ever opened.
    ses.setPermissionRequestHandler((_contents, permission, callback, details) => {
      callback(false);
      if (permission !== "media") return;
      events.push(`request:${(details.mediaTypes ?? []).join("+") || "none"}`);
      resolve();
    });
  });
  const win = await hiddenWindow(`${config.page}usermedia`, { partition: "smoke-usermedia" });
  try {
    const box = await win.webContents.executeJavaScript(
      '(() => { const e = document.querySelector("usermedia"); const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, supported: !(e instanceof HTMLUnknownElement) }; })()',
    );
    if (!box.supported) {
      report(
        "media: a <usermedia> click reaches the check handler, then the request handler",
        false,
        "<usermedia> is not supported",
      );
      return;
    }
    const x = Math.round(box.x);
    const y = Math.round(box.y);
    // The element ignores clicks for a moment after it appears and says nothing when it's ready,
    // so click until its requests come, within a bound.
    const attempts = Math.ceil(NO_ANSWER_MS / CLICK_INTERVAL_MS);
    let answered = false;
    for (let attempt = 0; attempt < attempts && !answered; attempt++) {
      win.webContents.sendInputEvent({ type: "mouseDown", x, y, button: "left", clickCount: 1 });
      win.webContents.sendInputEvent({ type: "mouseUp", x, y, button: "left", clickCount: 1 });
      answered = await Promise.race([
        requested.then(() => true),
        delay(CLICK_INTERVAL_MS).then(() => false),
      ]);
    }
    if (!answered) {
      const state = await win.webContents.executeJavaScript(
        "JSON.stringify({ visibility: document.visibilityState, focus: document.hasFocus() })",
      );
      report(
        "media: a <usermedia> click reaches the check handler with each device, then typeless requests",
        false,
        `no media request after clicking (${events.join(" ") || "no calls"}; page ${state})`,
      );
      return;
    }
    // The element's requests come in one task; a round trip to the page lets them all arrive.
    await win.webContents.executeJavaScript("null");
    const firstRequest = events.findIndex((e) => e.startsWith("request:"));
    const checksBefore = events.slice(0, firstRequest).filter((e) => e.startsWith("check:"));
    const typeless = events
      .filter((e) => e.startsWith("request:"))
      .every((e) => e === "request:none");
    report(
      "media: a <usermedia> click reaches the check handler with each device, then typeless requests",
      checksBefore.includes("check:video") && checksBefore.includes("check:audio") && typeless,
      events.join(" "),
    );
  } finally {
    win.destroy();
  }
}

const checks = [
  fileOpenedForReadingAsksBeforeWrite,
  fileSavedBySiteIsQuarantined,
  downloadIsQuarantined,
  localNetworkAccess,
  exitExclusiveAccess,
  userMediaElement,
];

if (process.platform === "darwin") app.setActivationPolicy("accessory");
// Each check closes its windows; the app quits once all checks are done, not before.
app.on("window-all-closed", () => {});

app.whenReady().then(async () => {
  for (const check of checks) {
    try {
      await check();
    } catch (error) {
      report(check.name, false, error instanceof Error ? error.message : String(error));
    }
  }
  fs.rmSync(scratch, { recursive: true, force: true });
  console.log("SMOKE_DONE");
  app.quit();
});
