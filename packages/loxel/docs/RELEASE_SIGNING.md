# Releasing the desktop app: macOS signing and provisioning

Release builds of `packages/loxel` are signed with the Developer ID certificate in the `LOXEL_CERTIFICATE` secret and notarized with the App Store Connect API key secrets. Passkey support adds one more input: the `keychain-access-groups` entitlement in `assets/entitlements.mac.plist` is restricted, and macOS refuses to launch a Developer ID app that carries it unless the bundle embeds a provisioning profile granting it. The release workflow therefore requires the `LOXEL_PROVISIONING_PROFILE` secret and fails before building when it is missing.

To create or renew the profile:

1. In the Apple Developer portal, open **Identifiers**, select the `com.bizimind.loxel` App ID and enable the **Keychain Sharing** capability. The access group Loxel uses is `JJ88G244AR.com.bizimind.loxel.webauthn` (see `src/electron/webauthn.ts`); a Developer ID profile grants `<TEAM_ID>.*`, so no group list is needed there.
2. Under **Profiles**, create a **Developer ID Application** profile (not Development or App Store) for that App ID and the release certificate, then download it.
3. Check it with `security cms -D -i Loxel.provisionprofile` and confirm `application-identifier` and `keychain-access-groups` are present.
4. Store it as the repository secret: `base64 -i Loxel.provisionprofile | pbcopy`, then paste into `LOXEL_PROVISIONING_PROFILE`.
5. For a passkey-capable local build, copy the file to `build/embedded.provisionprofile` and run `pnpm run build:app:local` from `packages/loxel` (or `build:app` for DMG/zip). Without it, `scripts/build-app.ts` signs with `assets/entitlements.mac.unprovisioned.plist` so the app still launches, with passkeys disabled.

Developer ID profiles expire; renew before the date shown in the portal or the next release build fails at the profile check.
