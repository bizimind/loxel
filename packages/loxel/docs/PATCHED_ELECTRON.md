# Patched Electron

Loxel's releases run on a patched build of Electron, not the npm package's binary. The patches in [`electron/patches/`](../electron/patches/) add WebAuthn features Electron doesn't have yet: security key PIN entry (`collect-webauthn-pin`) and signing in with a passkey from a phone over the FIDO hybrid transport (`webauthn-hybrid-request`). They come from the open upstream PRs electron/electron#55426 and #55427, plus a fix so the QR code is only offered when the request can actually use the phone. When Electron ships these, the patches are deleted and Loxel goes back to stock Electron.

## What defines a build

- **The Electron release** is the exact `electron` version in `package.json`. It must be a plain version (`45.3.0`), never a range: the npm package provides the types and the version electron-builder packages, and the patched binary has to match it.
- **The patches** are applied in file-name order with `git am` onto that release's tag.
- **The build ID** is the version plus a digest of the patches' names and contents (`buildId()` in [`scripts/electron-dist.ts`](../scripts/electron-dist.ts)). Changing, adding or reordering a patch, or bumping the version, gives a new ID, so a release can never pair new source with an old binary.

Builds live in the private CI bucket `loxel-ci-private` at `electron/<build ID>/electron-v<version>-darwin-<arch>.zip`, each with a `.sha256` file next to it. They are an input to the release, not a download, so they stay out of the public release bucket.

## Building and uploading

Electron and Chromium build from source on a Mac, for arm64 and for x64 (cross-compiled on Apple silicon):

```bash
pnpm -C packages/loxel run build:electron            # both architectures, then upload
pnpm -C packages/loxel run build:electron -- --arch arm64 --no-upload
```

[`scripts/build-electron.ts`](../scripts/build-electron.ts) uses Electron's build tools (`npm i -g @electron/build-tools`) with one config per architecture (`loxel-release-arm64`, `loxel-release-x64`) sharing a checkout at `~/git/open-source/electron-loxel` (override with `--root` or `LOXEL_ELECTRON_ROOT`). It checks out the release tag, applies the patches, syncs Chromium and builds Electron's release configuration. Before uploading, it checks that each zip reports the pinned version and holds the right architecture. Each zip is kept under `<root>/loxel-dist/<build ID>/` and copied to `build/electron-dist/` for local packaging. A build already in R2 (zip and checksum both present) is skipped, and one already built for the same ID, for example by a `--no-upload` run, is only uploaded; `--force` rebuilds either. An existing build config must point at the same checkout, or the script stops.

Needs Xcode with its Metal toolchain (`xcodebuild -downloadComponent MetalToolchain`), about 150 GB of free disk, and an R2 API token with write access to `loxel-ci-private` in the root `.env`: `R2_PRIVATE_ACCESS_KEY_ID`, `R2_PRIVATE_SECRET_ACCESS_KEY` and `CLOUDFLARE_ACCOUNT_ID`, the same names as the CI secrets. The first run clones about 30 GB; a release build takes several hours per architecture on a laptop.

## Releases

`release-loxel.yml` first runs `fetch-electron.ts --check`, which fails before the version is bumped unless the current build ID is in R2 for both architectures, so a missing build leaves no release commit or tag behind. Each architecture's job then runs [`scripts/fetch-electron.ts`](../scripts/fetch-electron.ts), which downloads the zip into `build/electron-dist/` and verifies its checksum, and electron-builder packages it through `--config.electronDist`. So upload the build before merging a change to the Electron version or the patches.

Local packaged builds (`build:app`, `build:app:local`) use the patched zip in `build/electron-dist/` (put there by `fetch-electron.ts` or `build-electron.ts`, with a `.build-id` marker next to it) and stock Electron when there is none. A zip whose marker names another build ID stops the build, so one left from before a patch change is never packaged as current. Dev runs and tests use the npm package's stock binary; to run dev on a patched build, unzip it and point `ELECTRON_OVERRIDE_DIST_PATH` at the folder holding `Electron.app/Contents/MacOS/Electron`.

## Updating

- **A new Electron patch release** carries Chromium security fixes, and browser panels load arbitrary sites, so take each one promptly. Dependabot ignores `electron`, so nobody gets a bump that skips these steps: bump the exact version in `package.json`, rebase the patches onto the new tag (they touch only `shell/browser/webauthn/`, the spec and the docs, so they usually apply unchanged), build and upload, then merge.
- **A patch that no longer applies**: rebase it in an Electron checkout on the new tag and regenerate it with `git format-patch --zero-commit --no-signature`.
- **Upstream ships the feature**: delete the patches it covers. With none left, remove the fetch step and `electronDist` flag from the release workflow and this pipeline.
