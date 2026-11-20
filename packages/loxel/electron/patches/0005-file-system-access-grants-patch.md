# 0005 File System Access: the check handler can only take access away

## What and why

With a session permission check handler set, Electron decided each File System Access grant's status from the handler alone: `true` meant granted and `false` denied, so no grant was ever "ask". An app has to answer `true` for `fileSystem`, or files the user picks stop working, and that answer also covered access the user never gave: writing to a file picked only for reading, and reading and writing through handles a site kept in IndexedDB on a later visit. Chrome asks the user in both cases.

The patch makes the handler a veto in `PermissionGrantImpl::GetStatus`: `false` still denies, and `true` returns the grant's own status, which a picker, a drop, an ancestor directory or a permission request set. A grant still to be asked for stays "ask", so the page must request it, which calls the session's permission request handler, where Chrome would prompt. With no check handler, nothing changes.

Loxel's side: `browser-permissions.ts` still answers `true` to the `fileSystem` check, and hands each `fileSystem` request to `browser-file-access.ts`, which asks the user in the panel's bar.

## Files

- Electron: `shell/browser/file_system_access/file_system_access_permission_context.cc`, `docs/api/session.md` (the check handler's `fileSystem` entry), `spec/chromium.spec.ts` (File System API specs).
- Chromium (read, not changed): `content/browser/file_system_access/file_system_access_handle_base.cc` (`DoRequestPermission`, which requests only an "ask" grant), `content/browser/file_system_access/file_system_access_manager_impl.cc` (picker grants), `chrome/browser/file_system_access/chrome_file_system_access_permission_context.cc` (Chrome's behavior).

## Testing

- Electron specs: `e test --files spec/chromium.spec.ts -g "File System"` on a testing build. "asks the request handler before writing a readable file whose checks are allowed" covers the change; "calls twice when trying to query a read/write file handle permissions" now expects `prompt` for read and write, since pasting grants read only.
- In Loxel, in a hidden demo: a page opens a file with `showOpenFilePicker()` (or a dropped file), and `createWritable()` on it shows the panel's file access bar before anything is written; Block leaves the file unchanged.

## Rebase notes

Electron copies Chrome's permission context into this file now and then (45.4.1 brought case-insensitive blocked paths), so look for conflicts in `GetStatus` and in the `PermissionGrantImpl` constructor around it. If upstream rewrites `GetStatus` to consult `status_` itself, check whether the patch is still needed before carrying it.

## Upstream

Reported to Electron privately. Delete the patch once an Electron release carries an equivalent fix.
