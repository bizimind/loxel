# 0003 WebAuthn hybrid transport (passkeys from a phone)

## What and why

Adds the `webauthn-hybrid-request` and `webauthn-hybrid-request-completed` session events. Chromium adds the hybrid (caBLE v2) transport to every WebAuthn request but only creates its discovery once the embedder configures a QR generator key in `ConfigureDiscoveries`, which Electron never did, so a request a site meant to serve over hybrid sat with no UI and no error. The patch generates the key, emits the `FIDO:/` QR payload for the app to draw, and configures the discovery only when a listener accepted it. It keeps the Bluetooth callbacks so the OS permission prompt can be requested, and emits the completed event when the request ends so the app can take the code down. Requests with conditional or passkey-upgrade UI are skipped, as are platforms where Chromium wouldn't create the discovery.

It also lets a `collect-webauthn-pin` listener (0001) answer `{ useAnotherDevice: true }`, which starts the request over with the same QR code, as Chrome's "use another device": a lone PIN-protected key otherwise binds the request before a phone can connect.

Loxel draws the code over the browser panel that asked (`installHybridQrCode` in `src/electron/webauthn.ts`).

## Files

- Electron: `shell/browser/webauthn/electron_authenticator_request_client_delegate.{cc,h}`, `docs/api/session.md`, `spec/api-web-authn.spec.ts`.
- Chromium (read, not changed): `content/public/browser/authenticator_request_client_delegate.h` (`ConfigureDiscoveries`), `device/fido/cable/v2_handshake.h` (`qr::Encode`), `device/fido/fido_discovery_factory.h`.

## Testing

`e test --files spec/api-web-authn.spec.ts` on a testing build (the hybrid specs use the virtual authenticator UI). In Loxel, a passkey sign-in in a browser panel shows the QR code over that panel and a phone can complete it; that needs a phone and Bluetooth, so it is a manual check.

## Rebase notes

Chromium changes `ConfigureDiscoveries`' parameters or the `cablev2` helpers every few releases; that is where conflicts come from. 0004 changes the same functions, so rebase them together.

## Upstream

The third commit of [electron/electron#55427](https://github.com/electron/electron/pull/55427), still open (that PR also carries #55426's commits). Delete it, with 0004, once Electron ships it.
