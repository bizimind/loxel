---
name: legal
description: Privacy, licensing and legal rules for Loxel. Use for any change touching telemetry, analytics, data collection, network requests, accounts/login, third-party dependencies, binaries, fonts or vendored code, licensing, or any legal decision.
---

# Legal

Sources of truth: the [privacy policy](https://bizimind.io/privacy) (`packages/site/src/pages/privacy.md`) and `LICENSE`. Read the one that applies before deciding. This skill is not legal advice: open legal questions, such as whether cookieless analytics needs consent under ePrivacy, and any change to the rules below belong to the user, so raise them in the PR instead of settling them.

## Privacy

The app promises four things: no data collected without consent, no account, subscription or login required, no training on or selling user data, and any change to these shown clearly with confirmation required. The promises cover the app. The website is scoped separately and counts visits without asking, which the policy states openly.

| Change                                                                                      | Required                                                                                                                                        |
| ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| New request off the user's machine: telemetry, crash reports, update, schema, registry, CDN | Opt-in with clear consent, or a disclosed action the user starts. Update the policy and its effective date in the same PR                       |
| Automatic request the policy already lists                                                  | Keep it within what the policy says, and give users a setting to turn it off where it can have one                                              |
| New or upgraded bundled binary or language server                                           | Verify what it does on the network (below) before it ships                                                                                      |
| Install counts from manifest or update checks                                               | Leave out: that is collection without consent                                                                                                   |
| Account or login requirement, or anything else that changes the promises                    | Ask the user first. The release must show the change in the app and require confirmation, and has to build that mechanism since none exists yet |
| New site analytics event, or a PostHog setting or plan change                               | Stay within what the policy lists or update it in the same step. Autocapture, heatmaps and dead clicks stay off; retention depends on the plan  |
| New third-party asset on the site                                                           | Self-host it, as the fonts are. Anything loaded from another host is a new recipient the policy must name                                       |

A setting proves nothing until tested, and a vendor's telemetry opt-out may be neither honored nor complete. docker-language-server ignored the shape Loxel sent `telemetry: "off"` in (#634), and even a correct one still lets its first heartbeat and BugSnag reports out (#820). PostHog's `respect_dnt` does nothing in cookieless mode, so the site checks Do Not Track and Global Privacy Control itself and skips loading PostHog.

To verify a binary, run it with Loxel's real config and a real file open, and log every non-loopback connect and DNS lookup at the socket level with a `DYLD_INSERT_LIBRARIES` interposer. Re-sign a scratch copy ad hoc first if it has the hardened runtime, which ignores DYLD. Run a positive control, because a clean result proves nothing unless the same setup catches a binary known to phone home. A dead-end proxy misses traffic that ignores proxy variables, and `lsof` sampling misses short-lived sockets. The interposer and an example driver are in `packages/loxel/scripts/network-audit/`.

Report security vulnerabilities privately, per `SECURITY.md`, or fix them directly. Keep them out of public GitHub issues.

## Licensing

The repo is FSL-1.1-ALv2: source available for non-competing use, with each version becoming Apache 2.0 on its second anniversary. Describe it as "source available", never "open source" or "free software". Keep `LICENSE` and its copyright notice intact. Relicensing is the user's decision.

Check the license before adding a dependency, vendored code, font, template or binary:

| License                                                         | Use                                                                                                   |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| MIT, BSD, ISC, Apache-2.0, OFL (fonts), CC BY, other permissive | Fine. Keep the required notice or credit                                                              |
| MPL, LGPL, EPL                                                  | Only unmodified, as a separate package or binary, shipped with its notice and where to get its source |
| GPL, AGPL, SSPL, share-alike, non-commercial, none              | Ask the user first                                                                                    |

Keep attributions with what they credit: the upstream `LICENSE` next to vendored assets, as in `packages/loxel/public/icons/LICENSE`, and the CC BY 4.0 credit to 37signals at the bottom of the privacy policy.

The build generates `THIRD_PARTY_NOTICES.txt` for the app, `wt` and `code-analysis` from their npm dependencies. A new bundled binary or language server needs `license`, `source` and `licenseFile` in its manifest (`scripts/language-servers/`); a new font, icon set or vendored code needs an entry in `packages/loxel/third-party.json`. The build fails on a manifest without them.
