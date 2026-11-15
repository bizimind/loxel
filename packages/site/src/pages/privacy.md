---
layout: ../layouts/Page.astro
title: Privacy policy
description: What the Loxel app and the bizimind.io website collect and why, who receives it, and your rights.
---

_Effective November 6, 2026_

This policy covers the Loxel desktop app and the bizimind.io website: what data is involved and why, how it is handled, and your rights.

## The short version

For the Loxel app, we promise:

- **No data collected without your consent.**
- **No selling your data, and no training on it.**
- **No silent changes.** Any change to these promises will be shown clearly in Loxel and will require your confirmation.

**On the bizimind.io website**, we use cookieless analytics to understand how the site is used. It stores nothing in your browser, isn't linked to your name or an account, doesn't follow you across days or other sites, and doesn't load if your browser sends Do Not Track or Global Privacy Control. We don't sell this data or share it with advertisers, and it's processed only by our hosting and analytics providers. [The details are below.](#the-bizimindio-website)

## The Loxel app

### What stays on your machine

Loxel runs on your computer. You don't need an account to use it, so we hold no profile of you. It doesn't track how you use it. Your code, files, projects, settings and logs are stored locally and stay on your machine unless you choose to send them somewhere.

### When Loxel connects to the internet

Like most desktop software, Loxel uses the network for a few routine things, such as checking for updates and downloading public resources that editor features need. These requests don't include your code, your file contents or how you use the app. Like any web request, they reveal your IP address and basic client details to the server that answers. You can turn off much of this in Settings. Update checks keep Loxel current and secure, which is their only purpose and our legitimate interest under the GDPR. Our separate command-line tools contact the same update service only to check for or install updates.

### Services and tools you choose to use

Some things you do in Loxel connect to other services directly from your computer, such as browsing the web, using Git remotes, running commands in a terminal, or opening content that loads resources from the web. Loxel can also run developer tools you have installed, and those tools may contact their own services. In a repository you choose to trust, Loxel also runs that repository's own build scripts, hooks and plugins, which do whatever their code does. Those connections don't go through us, and those services' own terms apply.

**Loxel itself doesn't send your code to any AI provider.** AI coding agents you run in Loxel are separate programs that Loxel does not control, and their providers' terms apply.

### Third-party components

Loxel bundles language tools and other components made by third parties, and some of them need the network to do their job, for example to download metadata that your files or settings refer to. We review these components before we ship them and configure them to keep to this policy. They are developed independently and change over time, so we can't guarantee how every version behaves in every situation.

If you find a bundled component collecting or sending data in a way this policy doesn't describe, please [tell us](#changes-and-questions). We treat that as a bug, or as a security issue where it warrants, and we work to fix it promptly.

## The bizimind.io website

### What we collect and why

We collect only what we need. All of this comes directly from your browser. We rely on our legitimate interests (GDPR Article 6(1)(f)): understanding whether the site works, and delivering our site and app securely.

| Data                                                                                                                                  | Why                                                             | Who receives it                                   | How long it is kept                                                                                                             |
| ------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| **Analytics:** the page and device details described below                                                                            | See which pages help people and whether the download path works | PostHog (EU cloud, Frankfurt), through Cloudflare | One year                                                                                                                        |
| **Request data** for the site, downloads and update checks: IP address, browser or client details, the address requested and the time | Serve them and protect them from abuse                          | Cloudflare                                        | For as long as Cloudflare needs it to run and secure its network, under [its policy](https://www.cloudflare.com/privacypolicy/) |

You aren't required to provide any of this, and the site works with analytics blocked. We don't make automated decisions about you or build profiles.

### How the analytics works

We record which pages are viewed, how visitors arrive and how far they read, which links and downloads they choose, and general browser, device, language and time zone details. Addresses can include campaign or ad-click parameters.

The site stores no cookies or other data in your browser. Requests reach PostHog through the website's own address, which passes along your IP address and browser details. PostHog combines them with a random value that changes daily to produce a visitor hash, so a visit can be followed across pages within one day but not across days. As [PostHog describes](https://posthog.com/docs/privacy/cookieless-tracking), your IP address and full browser user-agent string are then removed. They aren't stored with events, and your IP address isn't used to work out your location. We don't record sessions, link visits to a name or account, or use advertising networks.

**You have the right to object to this analytics at any time.** We honor Do Not Track and Global Privacy Control: if your browser sends either, the analytics script isn't loaded and nothing is sent. You can also block JavaScript or requests to `/ingest` on the website, or email us.

## If you contact us

If you email us, we use your address and message only to reply to you, and keep them only as long as needed to handle your request, or until you ask us to delete them. They're handled by us and our email provider.

## Sharing and location of data

We don't sell your personal information or use it to train AI models. We share it only with the providers named above, who handle it to provide their services, and with authorities when the law requires it. If Bizimind is acquired or merges with another company, we'll say so in this policy before your information becomes subject to a different policy.

PostHog stores analytics in the EU. Cloudflare runs a global network, so your requests may be handled outside your country, including in the United States, and email may also be handled outside the EU. Where data leaves the EEA or UK, transfers rely on safeguards such as Standard Contractual Clauses or an adequacy decision such as the EU-U.S. Data Privacy Framework. Email us for details of the safeguards that apply.

## Your rights

We apply the same rights to everyone, regardless of where you live. You can ask to access, correct, erase or receive a copy of the personal information we hold about you, restrict or object to how we use it, and withdraw consent whenever we have relied on it. You can also complain to your data protection authority.

Email [privacy@bizimind.io](mailto:privacy@bizimind.io) to use these rights. It's free, and we reply within the time the law requires, normally one month. Because analytics isn't tied to your name and the daily hash can't be recalculated later, we usually can't find a particular person's analytics events. If so, we'll tell you. Data in the Loxel app is on your computer, so you control it directly.

## Children

Loxel and the bizimind.io website are made for software developers and aren't directed at children under 16. We don't knowingly collect their data. If you believe a child has emailed us personal information, contact us and we will delete it.

## Security

The bizimind.io website and our downloads are served over HTTPS, and app updates are verified before they are installed. Your code isn't held on our servers. No system is perfectly secure. To report a vulnerability, see our [security policy](https://github.com/bizimind/loxel/blob/main/SECURITY.md).

## Who we are

Loxel is made by Bizimind ("we"). We decide how the personal data described in this policy is used, which makes us its "data controller" under privacy laws such as the GDPR.

## Changes and questions

If we change any of the promises in "The short version", Loxel will show you the change clearly and require your confirmation before it applies to you. For other changes, we'll update this policy and its effective date. You can see every past version [on GitHub](https://github.com/bizimind/loxel/commits/main/packages/site/src/pages/privacy.md).

This policy describes how we handle personal data. It doesn't change Loxel's [license](https://github.com/bizimind/loxel/blob/main/LICENSE), including its warranty disclaimer, and it doesn't limit any rights you have under data protection law.

For questions about this policy, requests, or anything involving your personal data, email [privacy@bizimind.io](mailto:privacy@bizimind.io) rather than posting publicly. For general questions about how Loxel works, use [GitHub issues](https://github.com/bizimind/loxel/issues).
