# 0007 Let apps turn Chromium's Local Network Access checks on

## What and why

Electron adds `LocalNetworkAccessChecks` to the disabled features, and a disabled feature wins over an enabled one, so an app's `--enable-features=LocalNetworkAccessChecks` had no effect. The patch disables it only when the app doesn't enable it itself, as Electron already does for `SpareRendererForSitePerProcess`, and shares the lookup between the two. Without the switch, nothing changes.

With the checks on, a request from a page or worker on a public address to a private or loopback address needs the `local-network` or `loopback-network` permission, decided in the network service once the connection's address is known and before the request is sent; one from a non-secure context is refused. Electron's permission manager never answers "ask", so the session's permission check handler decides alone.

Loxel turns the feature on in `main.ts` before the app is ready. Its permission check handler answers `local-network` and `loopback-network` from the site's saved decision or Allow this time (`browser-local-network.ts`), and its `webRequest` gate still asks the user first, so a request the user allows passes both. Through a proxy, the server's address isn't visible, as in Chrome.

## Files

- Electron: `shell/browser/feature_list.cc`, `docs/api/command-line-switches.md`, `spec/chromium.spec.ts` (Local Network Access).
- Chromium (read, not changed): `services/network/local_network_access_checker.cc` (`CheckAddressSpace`), `content/browser/renderer_host/local_network_access_util.cc` (the policy per context), `content/browser/storage_partition_impl.cc` (`OnLocalNetworkAccessPermissionRequired`).

## Testing

- Electron specs: `e test --files spec/chromium.spec.ts -g "Local Network Access"` on a testing build. A page on `127.0.0.1` counts as public through `--ip-address-space-overrides`; with the feature on, its fetch of another local port reaches the check handler as `loopback-network` and never reaches the server.
- In Loxel, in a hidden demo: a public page's fetch of `localhost` is refused before the local server sees it unless the site is allowed; an `http://localhost:<port>` page and an `http://<LAN address>:<port>` page both reach another `localhost` port with no prompt.

## Rebase notes

The disabled-features list in `InitializeFeatureList` changes often; keep the LNA entry out of it. If upstream turns the checks on by default, or lets apps opt in another way, drop the patch and keep Loxel's switch.

## Upstream

Not upstream yet; a PR to electron/electron is drafted. Delete the patch once Electron lets apps turn the checks on.
