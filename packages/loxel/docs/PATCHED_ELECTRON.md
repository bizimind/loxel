# Patched Electron

Loxel's releases run on a patched build of Electron, not the npm package's binary. The patches in [`electron/patches/`](../electron/patches/) add what Electron doesn't have yet: WebAuthn security key PIN entry and passkeys from a phone over the FIDO hybrid transport (from the open upstream PRs electron/electron#55426 and #55427, plus a fix so the QR code is offered only when the request can use the phone), File System Access prompts that stock Electron skips once an app sets a permission check handler, macOS quarantine for downloads and files sites save, a way for the app to turn Chromium's Local Network Access checks on, and a way for it to take a page out of fullscreen and pointer lock before showing a prompt over it. When Electron ships a patch's change, that patch is deleted, and with none left Loxel goes back to stock Electron.

## Patches

Each patch is a pair in `electron/patches/`: `<nnnn>-<name>.patch`, a `git format-patch` commit, and `<nnnn>-<name>-patch.md`, its doc. The four-digit number sets the order the patches apply in. Each doc says what the patch does and why, which Electron and Chromium files it touches, how to test it, where it is likely to conflict on the next bump, and its upstream status. `electron-dist.test.ts` checks that every patch has its doc.

| Patch                               | Doc                                                                                                       |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `0001-webauthn-pin-entry`           | [Security key PIN entry](../electron/patches/0001-webauthn-pin-entry-patch.md)                            |
| `0002-webauthn-pin-validation`      | [PIN validation by Chromium](../electron/patches/0002-webauthn-pin-validation-patch.md)                   |
| `0003-webauthn-hybrid-transport`    | [Passkeys from a phone](../electron/patches/0003-webauthn-hybrid-transport-patch.md)                      |
| `0004-webauthn-hybrid-qr-discovery` | [QR code only for hybrid discovery](../electron/patches/0004-webauthn-hybrid-qr-discovery-patch.md)       |
| `0005-file-system-access-grants`    | [File System Access check handler as a veto](../electron/patches/0005-file-system-access-grants-patch.md) |
| `0006-quarantine-service`           | [Quarantine service for downloads and saved files](../electron/patches/0006-quarantine-service-patch.md)  |
| `0007-local-network-access-opt-in`  | [Local Network Access opt-in](../electron/patches/0007-local-network-access-opt-in-patch.md)              |
| `0008-exit-exclusive-access`        | [`webContents.exitExclusiveAccess()`](../electron/patches/0008-exit-exclusive-access-patch.md)            |

## What defines a build

- **The Electron release** is the exact `electron` version in `package.json`. It must be a plain version (`45.4.1`), never a range: the npm package provides the types and the version electron-builder packages, and the patched binary has to match it.
- **The patches** are the `.patch` files, applied in numeric order with `git am` onto that release's tag. The docs beside them aren't part of the build.
- **The build ID** is the version plus a digest of the `.patch` files' names and contents (`buildId()` in [`scripts/electron-dist.ts`](../scripts/electron-dist.ts)). Changing, adding, renaming or reordering a patch, or bumping the version, gives a new ID, so a release can never pair new source with an old binary; editing a doc doesn't.

Builds live in the private CI bucket `loxel-ci-private` at `electron/<build ID>/electron-v<version>-darwin-<arch>.zip`, each with a `.sha256` file next to it that marks the upload complete. They are an input to the release, not a download, so they stay out of the public release bucket.

**The pinned hashes** in [`electron/builds.json`](../electron/builds.json) are the SHA-256 of each architecture's zip for the current build ID. The release accepts only a zip that matches them, so the bucket is storage, not a source of trust: a different binary needs a reviewed commit. `build-electron.ts` writes the file; commit it in the same change as the version or patches it builds.

## Building and uploading

Electron and Chromium build from source on a Mac, for arm64 and for x64 (cross-compiled on Apple silicon):

```bash
pnpm -C packages/loxel run build:electron            # both architectures, then upload
pnpm -C packages/loxel run build:electron -- --arch arm64 --no-upload
pnpm -C packages/loxel run build:electron -- --testing   # this Mac's architecture, to try a patch
```

[`scripts/build-electron.ts`](../scripts/build-electron.ts) uses Electron's build tools (`npm i -g @electron/build-tools`) with one config per configuration and architecture (`loxel-release-arm64`, `loxel-release-x64`, `loxel-testing-arm64`) sharing a checkout at `~/git/open-source/electron-loxel` (override with `--root` or `LOXEL_ELECTRON_ROOT`). It checks out the release tag, applies the patches, syncs Chromium and builds. Uncommitted changes or untracked files in `<root>/src/electron` stop it, since checking out the tag would discard them; `--force` discards them.

- **Release** (the default) builds Electron's release configuration into a zip. Before uploading, it checks that each zip reports the pinned version and holds the right architecture. Each zip is kept under `<root>/loxel-dist/<build ID>/`, copied to `build/electron-dist/` for local packaging, and pinned in `electron/builds.json`. A build already in R2 (zip and checksum both present) and pinned is skipped, and one already built for the same ID, for example by a `--no-upload` run, is only pinned and uploaded; `--force` rebuilds either.
- **Testing** (`--testing`) builds Electron's `testing` configuration (release with DCHECKs) for this Mac's architecture into `<root>/src/out/Testing-<arch>`, incrementally, never uploads, and prints the `ELECTRON_OVERRIDE_DIST_PATH` to run Loxel on it (Releases below). It reuses the checkout: one left exactly as it was prepared for the current build ID (the same commit, no changes) isn't checked out or patched again, and one synced for the same tag isn't synced again unless a current patch changes what the sync reads (Electron's Chromium patches, `DEPS`, its npm dependencies); after removing or reverting such a patch, run once with `--force` so the checkout is synced again; `<root>/loxel-prepared.json` records this, and `--force` prepares from scratch. After a patch changes, the build recompiles what any patch touches, not all of Chromium. Release builds always prepare and sync from scratch. Try a fix in a separate Electron checkout, not in `<root>/src/electron`, which the next run resets. Run Electron's own specs for a patch from `<root>/src/electron` with `e use loxel-testing-<arch>` and `e test --files <spec>`.

An existing build config must point at the same checkout, or the script stops. It needs Xcode with its Metal toolchain (`xcodebuild -downloadComponent MetalToolchain`), about 150 GB of free disk, and, to upload, an R2 API token with write access to `loxel-ci-private` in the root `.env`: `R2_PRIVATE_ACCESS_KEY_ID`, `R2_PRIVATE_SECRET_ACCESS_KEY` and `CLOUDFLARE_ACCOUNT_ID`, the same names as the CI secrets. The first run clones about 30 GB; a release build takes several hours per architecture on a laptop.

## Releases

`release-loxel.yml` first runs `fetch-electron.ts --check`, which fails before the version is bumped unless the current build ID is pinned in `electron/builds.json` and in R2 for both architectures, with the uploaded checksum matching the pin, so a missing or mismatched build leaves no release commit or tag behind. Each architecture's job then runs [`scripts/fetch-electron.ts`](../scripts/fetch-electron.ts), which downloads the zip into `build/electron-dist/` and checks it against the pinned SHA-256, and electron-builder packages it through `--config.electronDist`. So upload the build, and commit `electron/builds.json`, before merging a change to the Electron version or the patches.

Local packaged builds (`build:app`, `build:app:local`) use the patched zip in `build/electron-dist/` (put there by `fetch-electron.ts` or `build-electron.ts`, with a `.build-id` marker next to it) and stock Electron when there is none. A zip whose marker names another build ID stops the build, so one left from before a patch change is never packaged as current. Dev runs and tests use the npm package's stock binary; to run dev on a patched build, point `ELECTRON_OVERRIDE_DIST_PATH` at the folder holding `Electron.app/Contents/MacOS/Electron`: a testing build's output directory, or an unzipped release zip.

## Updating

- **A new Electron patch release** carries Chromium security fixes, and browser panels load arbitrary sites, so take each one promptly. Dependabot ignores `electron`, so nobody gets a bump that skips these steps:
  1. Bump the exact version in `package.json` (pnpm's `minimumReleaseAge` accepts a release a week after it is published; for an urgent security release, add it to `minimumReleaseAgeExclude` in `pnpm-workspace.yaml` until then).
  2. Rebase the patches onto the new tag: in a checkout of Electron, check out the tag, `git am --3way` the `.patch` files in order, fix any conflict with the patch's doc's rebase notes, and regenerate each, keeping its file name: `git format-patch -1 <commit> --stdout --zero-commit --no-signature --no-numbered > <nnnn>-<name>.patch`. Update a doc whose files or notes changed.
  3. Build with `--testing`, run each patch's specs, run the smoke test on that build (`ELECTRON_OVERRIDE_DIST_PATH=<dir> bun scripts/patched-electron-smoke.ts` from `packages/loxel`), and check the behavior below in a hidden demo ([ELECTRON.md](ELECTRON.md#demo-mode)) on `ELECTRON_OVERRIDE_DIST_PATH`. The smoke test ([patched-electron-smoke.ts](../scripts/patched-electron-smoke.ts)) starts a hidden Electron app on local test pages and checks what Loxel takes from each patch, plus the `<usermedia>` element's permission calls; it prints one line per check and fails if any does. CI can't run it: it needs a patched build and macOS.
  4. Build and upload the release for both architectures, commit the updated `electron/builds.json` with the bump, then merge.
- **Behavior to recheck on a bump**, in a hidden demo on the patched build:
  - A click on a page's `<usermedia>`, `<camera>` or `<microphone>` element (Google Meet's "Use microphone and camera" is a `<usermedia>`) must still reach the browser session's check handler once per device it asks for, with `mediaType` set, before the request handler's `media` calls without `mediaTypes`, all in one task: `requestFromElement` in [browser-media.ts](../src/electron/browser-media.ts) asks for the last devices `checkedDevices` recorded before the calls, one per call. Check it with local pages holding `<usermedia type="camera microphone">`, `<camera>` and `<microphone>`: each click shows the panel's bar for exactly the element's devices, and Allow lets the page's `getUserMedia()` in without a second bar.
  - Each patch's own check, from the Testing section of its doc: a file opened for reading asks before it is written (0005); a completed download and a file a page saves get `com.apple.quarantine` (0006); a public page's request to `localhost` is refused before the local server sees it unless the site is allowed, while `http://localhost` and LAN-address pages reach other local ports without asking (0007); `exitExclusiveAccess()` on a fullscreen guest exits fullscreen and does nothing otherwise (0008).
- **A patch that no longer applies**: rebase it as in step 2. Its doc's rebase notes name the likely conflict spots.
- **Upstream ships a patch's change**: delete the patch and its doc, and update the table above. With none left, remove the fetch step and `electronDist` flag from the release workflow and this pipeline.
