# 0002 WebAuthn PIN validation by Chromium

## What and why

Follows up 0001. Chromium's `AuthTokenRequester` already validates every PIN entered (length, encoding, same as the current one) and asks again through `CollectPIN()` with the error set, so Electron's own second validation is removed. A callback from an earlier prompt of the same request is ignored, so a late answer to a superseded prompt can't answer the current one. The docs describe `error` and `minPinLength` as Chromium reports them, and the warning shown without a listener names the event that enables PIN entry.

## Files

- Electron: `shell/browser/webauthn/electron_authenticator_request_client_delegate.{cc,h}`, `docs/api/session.md`, `spec/api-web-authn.spec.ts`.
- Chromium (read, not changed): `device/fido/auth_token_requester.cc`, `device/fido/pin.h`.

## Testing

`e test --files spec/api-web-authn.spec.ts` on a testing build: the specs on the simulated UV-locked security key cover a correct, wrong, too-short and cancelled PIN.

## Rebase notes

Applies on top of 0001 in the same functions, so it conflicts wherever 0001 does. Chromium renaming `device::pin::PINEntryError` values shows up in the error-name mapping.

## Upstream

The second commit of [electron/electron#55426](https://github.com/electron/electron/pull/55426), still open. Delete it with 0001.
