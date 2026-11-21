# 0004 Offer the hybrid QR code only when the request runs hybrid discovery

## What and why

Loxel's fix on top of 0003. 0003 emitted `webauthn-hybrid-request` from `ConfigureDiscoveries`, before the request's transports are known, so a request whose allow list excludes hybrid (for example every credential lists only `internal`), or one where Chromium couldn't create the discovery, still showed a QR code that a phone could scan but never complete. The event now waits for `OnTransportAvailabilityEnumerated` and fires once, only when the available transports include hybrid; a restart keeps the code already shown.

## Files

- Electron: `shell/browser/webauthn/electron_authenticator_request_client_delegate.{cc,h}`, `spec/api-web-authn.spec.ts`.
- Chromium (read, not changed): `device/fido/fido_request_handler_base.h` (`TransportAvailabilityInfo`).

## Testing

`e test --files spec/api-web-authn.spec.ts` on a testing build: the added spec checks that an allow list without hybrid emits no event.

## Rebase notes

Shares functions with 0003; rebase the two together. Chromium renaming `TransportAvailabilityInfo::available_transports` would show up here.

## Upstream

Not upstream yet. Offer it to [electron/electron#55427](https://github.com/electron/electron/pull/55427), and delete it once Electron ships the hybrid events with this behavior.
