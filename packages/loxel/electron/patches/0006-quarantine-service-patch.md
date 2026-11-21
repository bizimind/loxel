# 0006 Quarantine service for downloads and saved files

## What and why

Chromium marks a completed download, a page saved with `webContents.savePage()`, and a file the File System Access API writes or moves, through a quarantine service the embedder connects it to (`GetQuarantineConnectionCallback` on `DownloadManagerDelegate` and `ContentBrowserClient`). Electron overrode neither. On Windows Chromium then writes the Mark of the Web itself, but on macOS it writes nothing, so such files had no `com.apple.quarantine` and Gatekeeper never checked them when opened. That includes an existing file a page saves over, as in Chrome.

The patch connects both to a quarantine service in the browser process, as Chrome does outside Windows (`ChromeDownloadManagerDelegate::ConnectToQuarantineService`). On macOS that also records the file's source URLs (`kMDItemWhereFroms` and the quarantine event). One static, `ElectronDownloadManagerDelegate::QuarantineServiceConnection()`, serves both overrides. Windows keeps Chromium's own Mark of the Web, and on Linux Chromium's service does nothing.

Chromium marks a download only once it is complete (`DownloadFile::RenameAndAnnotate`), and Electron has Chromium write a download straight to its save path (Loxel sets one in Downloads), so Loxel's `browser-downloads.ts` keeps marking the file while it downloads and when it moves it where the user chose. Chromium's service merges into an attribute already there, adding the URLs, and Loxel leaves an attribute it finds in place, so Chromium's survives when Chromium marks first.

## Files

- Electron: `shell/browser/electron_download_manager_delegate.{cc,h}`, `shell/browser/electron_browser_client.{cc,h}`, `BUILD.gn` (`//components/services/quarantine` in `electron_lib`), `spec/api-session.spec.ts` (DownloadItem).
- Chromium (read, not changed): `components/download/internal/common/base_file.cc` (`AnnotateWithSourceInformation`), `content/browser/download/save_package.cc`, `content/browser/file_system_access/file_system_access_safe_move_helper.cc`, `components/services/quarantine/quarantine_mac.mm`, `chrome/browser/download/chrome_download_manager_delegate.cc`.

## Testing

- Electron spec: `e test --files spec/api-session.spec.ts -g "quarantines a completed download"` on a testing build (macOS): the file has `com.apple.quarantine` and `kMDItemWhereFroms`.
- In Loxel, in a hidden demo: a completed download from a browser panel, and a file a page saves with `showSaveFilePicker()` and `createWritable()`, both have `com.apple.quarantine` (`xattr -p com.apple.quarantine <file>`), and `mdls -name kMDItemWhereFroms <file>` lists the download's URL.

## Rebase notes

`electron_browser_client.{cc,h}` change in most releases; the override sits next to `GetApplicationLocale`. A conflict in `BUILD.gn`'s `electron_lib` deps is a neighbouring line. Chromium could change `QuarantineConnectionCallback` or `QuarantineImpl`'s constructor; Chrome's `ConnectToQuarantineService` shows the current form. The patch links `quarantine_mac.mm`, which calls `MDItemSetAttribute`, an API Mac App Store builds avoid; Loxel makes none.

## Upstream

No public upstream PR. Delete the patch once an Electron release carries an equivalent fix.
