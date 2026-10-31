---
layout: ../layouts/Page.astro
title: Privacy policy
description: What the Loxel app and this website collect and why, who receives it, and your rights.
---

_Effective October 30, 2026_

The privacy of your data, and it is your data, not ours, is a big deal to us. This policy lays out what data we collect and why, how it is handled, and your rights. The Loxel app and this website work differently, so they are covered separately.

## The short version

For the Loxel app:

- **Loxel never collects data about you without your consent.** We receive nothing from the app: it has no analytics, telemetry or crash reporting of its own, and your code and files stay on your machine unless you use a feature that sends them somewhere. One exception needs calling out: [a bundled Docker tool](#docker-language-server) sends data to Docker when you open a Dockerfile.
- **Loxel does not require an account, subscription or login.**
- **We do not train on or sell your data**, to AI labs or to any third party.
- **If any of this ever changes, Loxel will show you the change clearly and ask you to confirm it first.**

**This website is different.** It counts visits with PostHog analytics without asking first. That analytics uses no cookies, does not try to recognize you from one day to the next, and stays off if your browser sends Do Not Track or Global Privacy Control. [The details are below.](#this-website)

## Who we are

Loxel is made by Bizimind ("we"). Bizimind is the data controller for the website data described here and for requests to our update server. Contact us at [ori.100000@gmail.com](mailto:ori.100000@gmail.com). We have not appointed a data protection officer.

Loxel is a desktop app that runs on your computer, so what it holds stays with you and we never receive it. The only thing that reaches us from the app is the update check described below. This policy does not cover other websites, or the services you connect Loxel to yourself.

## The Loxel app

### What stays on your machine

Your projects, settings, agent sessions and logs are stored locally. App logs are kept in `~/.local/state/loxel/loxel/logs` and are not uploaded. API keys you add for the coding agent are stored encrypted on your computer.

### Requests Loxel makes on its own

Loxel makes two kinds of automatic requests. Neither sends your code, your file contents or how you use the app. Like any web request, they reveal your IP address and basic client details to the server that answers.

- **Update check.** By default, shortly after launch, Loxel asks `loxel.bizimind.io`, which is served by Cloudflare, for the latest version number. Updates are downloaded and installed only when you choose to in Settings > General. We rely on our legitimate interest in keeping the app up to date and secure, and we do not use these requests to track you. Cloudflare handles them as described under [Request data](#what-we-collect-and-why).
- **Schemas.** To check configuration files such as `package.json` and `tsconfig.json`, Loxel downloads public schemas from `json.schemastore.org`, and from any schema address named in a file you open, so that address's server sees the request. You can turn off each built-in schema in Settings > Schemas, though the TOML tool may still fetch SchemaStore's catalog when it starts. Bundled language tools can also fetch metadata that a project refers to.

### Docker language server

Loxel bundles Docker's language server to support Dockerfiles. It starts when you first open a Dockerfile, `Containerfile` or Docker Bake file, and it currently contacts these services without asking. Loxel doesn't yet turn this off, and we don't receive any of this data.

- **Docker telemetry** (`api.docker.com`): the editor's name and version, crash details, hashes of the Git remote and path of files you change, and the file's language.
- **Docker Scout** (`api.scout.docker.com`): the images named in your Dockerfile's `FROM` lines, to look up vulnerabilities.
- **BugSnag** (`sessions.bugsnag.com`), Docker's error reporting service: session and crash information.

Docker's [privacy policy](https://www.docker.com/legal/docker-privacy-policy/) applies. To avoid this, don't open those files in Loxel.

### Things that send data when you use them

- **The built-in coding agent** needs an [OpenRouter](https://openrouter.ai/) API key, from Settings > Models or the `OPENROUTER_API_KEY` environment variable. When you run it, your prompts, the code and files it reads, and the results of its tools go to OpenRouter and the model provider you chose, using your key. Its web tools also contact the sites and search services they use. We don't receive any of this. Those companies' terms apply, including whether a provider may train on your data, so check your [OpenRouter privacy settings](https://openrouter.ai/docs/guides/privacy/data-collection) and the provider you pick.
- **External coding agents** you run in Loxel's terminals, such as Claude Code or Codex, are separate programs. Loxel does not control what they send, and their providers' own terms apply.
- **The built-in browser** works like any browser: sites you visit see your requests, tabs you left open can reload when they're restored, and searches typed in its address bar go to Google. Its cookies and site data stay on your computer.
- **Web images** in Markdown files or agent output can load from wherever they're hosted, and that server sees the request.
- **Terminals and Git** connect wherever your commands and remotes point.

Our separate `wt` command-line tool has no telemetry either. It contacts `loxel.bizimind.io` only when you ask it to check for or install an update, or when you turn on its optional auto-update.

## This website

### What we collect and why

Our guiding principle is to collect only what we need. All of this comes directly from your browser or from what you send us. We rely on our legitimate interests (GDPR Article 6(1)(f)) for all of it: understanding whether the site works, delivering it securely, and answering you.

| Data                                                                                                                                                                                                                                                                                                                                                                                                                | Why                                                                               | Who receives it                                   | How long it is kept                                                                                                                                                |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Analytics:** pages viewed and their titles and addresses (including any campaign or ad-click parameters in them), referring site, how long a page was open and how far it was scrolled, which download you chose, clicks on GitHub and docs navigation links, whether the download prompt came into view, browser name and version, operating system, device type, screen and window size, language and time zone | See which pages help people and whether the download path works                   | PostHog (EU cloud, Frankfurt), through Cloudflare | One year                                                                                                                                                           |
| **Request data:** IP address, browser or client details, the address requested and the time                                                                                                                                                                                                                                                                                                                         | Serve the site, downloads and the app's update check, and protect them from abuse | Cloudflare (hosting and downloads)                | For as long as Cloudflare needs it to run and secure its network, under [its policy](https://www.cloudflare.com/privacypolicy/); we keep no server logs of our own |
| **Email:** your address and whatever you write to us                                                                                                                                                                                                                                                                                                                                                                | Answer you and keep a history of the conversation                                 | Us and our email provider                         | As long as needed to handle your request, or until you ask us to delete it                                                                                         |

You don't have to provide any of this. There is no account, form or contract, and the site works with analytics blocked. We don't make automated decisions about you or build profiles.

### How the analytics works

The site stores no cookies or other data in your browser. Analytics requests reach PostHog through this site's own address (`/ingest`), which passes along your IP address and browser details. PostHog combines them with a random value that changes daily to produce a visitor hash, so a visit can be followed across pages within one day but not across days. According to [PostHog's documentation](https://posthog.com/docs/privacy/cookieless-tracking), your IP address and full browser user-agent string are then removed. They aren't stored with events, and your IP address isn't used to work out your location. We keep the browser name and version, operating system and device type. We don't record sessions, link visits to a name or account, or use advertising networks.

**You have the right to object to this analytics at any time.** We honor Do Not Track and Global Privacy Control: if your browser sends either, the analytics script isn't loaded and nothing is sent. You can also block JavaScript or requests to `/ingest` on this site, or email us.

## When we access or disclose your information

We never sell your personal information or use it to train AI models. We share website data only with the providers named above, who handle it to provide their services. We disclose information to authorities only when the law requires it. If Bizimind is acquired or merges with another company, we'll say so on this page before your information becomes subject to a different policy.

## Location of site and data

PostHog stores analytics in the EU. Cloudflare runs a global network, so your requests may be handled outside your country, including in the United States, and we may read email from outside the EU. Where data leaves the EEA or UK, it is protected by Standard Contractual Clauses or an adequacy decision such as the EU-U.S. Data Privacy Framework. Email us for a copy of the safeguards that apply.

## Your rights with respect to your information

We apply the same rights to everyone, regardless of where you live:

- **Access** the personal information we hold about you.
- **Correct** information that is wrong.
- **Erase** your information.
- **Restrict** how we use it.
- **Object** to our use of it, including analytics.
- **Port** it, by receiving a copy to give to someone else.
- **Withdraw consent** whenever we have relied on it.
- **Complain** to your data protection authority.

Email [ori.100000@gmail.com](mailto:ori.100000@gmail.com) to use these rights. It's free, and we will reply within one month. Because analytics isn't tied to your name and the daily hash can't be recalculated later, we usually can't find a particular person's analytics events. If so, we'll tell you. Data in the Loxel app is on your computer, so you control and can delete it directly.

## Children

Loxel and this website are made for software developers and aren't directed at children under 16. We don't knowingly collect their data. If you believe a child has emailed us personal information, contact us and we will delete it.

## How we secure your data

This site and our downloads are served over HTTPS, and app updates are checked against a published checksum before they are installed. Because Loxel runs locally, your code isn't held on our servers, and securing your computer protects it. No system is perfectly secure. To report a vulnerability, see our [security policy](https://github.com/bizimind/loxel/blob/main/SECURITY.md).

## Changes and questions

If we change anything in the Loxel app section of "The short version", the app will show you the change clearly and require your confirmation before it applies to you. For other changes, we'll update this page and its effective date. You can see every past version [on GitHub](https://github.com/bizimind/loxel/commits/main/packages/site/src/pages/privacy.md).

Any questions about this policy, your data or your rights? Email [ori.100000@gmail.com](mailto:ori.100000@gmail.com).

---

<small>This policy is adapted from the [37signals (Basecamp) open-source privacy policy](https://github.com/basecamp/policies/tree/master/privacy), used under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). We rewrote and shortened it to describe a local desktop app and this website. 37signals does not endorse this policy.</small>
