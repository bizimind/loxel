# 0001 WebAuthn security key PIN entry

## What and why

Adds the `collect-webauthn-pin` session event. Chromium's FIDO layer asks its embedder to collect a security key's PIN, and Electron's authenticator request delegate reported no PIN support, so a key that requires user verification could never complete a request where the OS has no WebAuthn UI of its own. With a listener registered, Electron reports PIN support and emits the event with the relying party, the reason (`challenge`, `set` or `change`), the previous attempt's error, the minimum length and the attempts left; the listener answers through a callback, and calling it with nothing cancels the request. Without a listener nothing changes. Biometric enrollment that a key offers inline is skipped, as Chrome's "skip" button does.

Loxel doesn't listen to `collect-webauthn-pin` itself. It carries this patch because 0003 is built on it (its "use another device" answer).

## Files

- Electron: `shell/browser/webauthn/electron_authenticator_request_client_delegate.{cc,h}`, `docs/api/session.md`, `spec/api-web-authn.spec.ts`.
- Chromium (read, not changed): `device/fido/fido_request_handler_base.h` (`Observer::SupportsPIN`, `CollectPIN`, `StartBioEnrollment`), `content/public/browser/authenticator_request_client_delegate.h`.

## Testing

The Electron spec `spec/api-web-authn.spec.ts` drives Chromium's virtual authenticator: run it on a testing build with `e test --files spec/api-web-authn.spec.ts`. With 0002 applied it covers a correct, wrong, too-short and cancelled PIN.

## Rebase notes

Conflicts, when there are any, come from Chromium changing the `FidoRequestHandlerBase::Observer` PIN methods or the `AuthenticatorRequestClientDelegate` interface, and from upstream edits to the delegate or to the session events section of `docs/api/session.md`. 0002 and 0003 change the same functions, so rebase the three together.

## Upstream

From the open upstream PR [electron/electron#55426](https://github.com/electron/electron/pull/55426) (its first commit). Delete this patch, with 0002, once Electron ships it.
