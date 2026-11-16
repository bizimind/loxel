# Security Policy

## Supported Versions

Loxel and its CLI tools (`wt`, `code-analysis`, and the others in this repository) ship as a continuous series of releases from `main`. Security fixes go into the next release only; we do not backport them to older versions. Update to the latest release before you report an issue, and check that it still reproduces there.

| Version        | Supported |
| -------------- | --------- |
| Latest release | Yes       |
| Older releases | No        |

The hosted services (bizimind.io and `loxel.bizimind.io`) always run the current version.

## Reporting a Vulnerability

**Do not report security vulnerabilities through public GitHub issues, pull requests, or discussions.**

**Preferred:** Use [GitHub's private vulnerability reporting](https://github.com/bizimind/loxel/security/advisories/new) to report security issues directly. This keeps the discussion private and lets us coordinate the fix and disclosure with you.

**Alternative:** Email **security@bizimind.io**.

Please include:

- The affected component (for example the Loxel app, a CLI tool, or a hosted service) and its version
- A description of the vulnerability and its potential impact
- Steps to reproduce, or a proof of concept
- Any suggested fix or mitigation, if you have one

## What to Expect

- **Acknowledgement** within 48 hours of your report.
- **Assessment**: we confirm whether the issue is a vulnerability, agree on its severity, and keep you updated as we work on a fix.
- **Fix and disclosure**: once a fix is released, we publish a GitHub security advisory and credit you, unless you prefer to stay anonymous. Please keep the issue private until then.

## Scope

In scope:

- The Loxel desktop app and its local server
- The CLI tools and libraries in this repository
- The services this repository deploys: bizimind.io and the release downloads at `loxel.bizimind.io`

Out of scope:

- Vulnerabilities in third-party dependencies that do not affect Loxel; report those to the upstream project
- Denial of service, spam, or volumetric attacks against the hosted services
- Social engineering or physical attacks
- Findings from automated scanners without a demonstrated impact

## Safe Harbor

We will not pursue legal action against anyone who researches and reports vulnerabilities in good faith under this policy: avoid privacy violations, data destruction, and service disruption, only access data that belongs to you, and give us reasonable time to fix the issue before any public disclosure.
