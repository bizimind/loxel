# Contributing

## Getting Started

```bash
# Install dependencies
pnpm install

# Set up git hooks (runs automatically via prepare script)
pnpm run prepare
```

Copy `.env.example` to `.env` and fill in the required values. The repo uses [direnv](https://direnv.net/) to load it (`direnv allow` once); see Environment Setup in [AGENTS.md](AGENTS.md).

## Development

```bash
# Build a package
pnpm -C packages/<package> run build

# Run tests
pnpm -C packages/<package> run test

# Type check
pnpm -C packages/<package> run typecheck

# Lint and format
pnpm run lint
pnpm run fmt
```

See [AGENTS.md](AGENTS.md) for repo-wide commands, standards, and the package index; each package has its own README.

## Pull Requests

- Keep PRs focused — one feature or fix per PR
- Run `pnpm run lint:fix && pnpm run fmt` before pushing
- Ensure `pnpm run typecheck` passes for affected packages
- Tests must pass: `pnpm -C packages/<package> run test`

## Releasing

Releases are automated from `main` (see the CI & Releases section of [AGENTS.md](AGENTS.md)). The desktop app additionally needs macOS signing, notarization, and a provisioning profile; see [packages/loxel/docs/RELEASE_SIGNING.md](packages/loxel/docs/RELEASE_SIGNING.md).

## Reporting Issues

Use [GitHub Issues](../../issues) for bugs and feature requests. For security vulnerabilities, see [SECURITY.md](SECURITY.md).

Apply labels when you create an issue (see [Issue Labels](#issue-labels)), whether you file it by hand or from an agent, so it does not need a separate triage pass:

```bash
gh issue create --label fix,package:loxel,component:diff --title "..." --body "..."
```

## Issue Labels

Every issue carries one type label and at least one package label; component labels are optional. Package labels follow from the directories under `packages/`. The type and component vocabularies below are closed; do not invent new labels in them without updating this section.

**Type** (exactly one):

| Label   | Meaning                                                                               |
| ------- | ------------------------------------------------------------------------------------- |
| `feat`  | New capability or enhancement, including performance improvements that add capability |
| `fix`   | Something broken or behaving wrongly, including performance bugs and security fixes   |
| `chore` | Tests, docs, CI, refactors, dependency and tooling work, cleanup, process             |

**Package** (one or more): one `package:<dir>` label per directory under `packages/` the work touches (for example `package:loxel`, `package:wt`); a new package gets a new label. Use `package:repo` for repo-wide work (CI, dependencies, root tooling) that no single package owns.

**Component** (zero or more, prefer one or two): `component:<name>` only where it helps someone understand what the issue touches.

| Label                 | Meaning                                           |
| --------------------- | ------------------------------------------------- |
| `component:terminal`  | Terminals and PTY sessions                        |
| `component:editor`    | Code editor (Monaco)                              |
| `component:markdown`  | Markdown editor                                   |
| `component:diff`      | Diff viewer and review                            |
| `component:git`       | Git operations, commit graph, status              |
| `component:worktrees` | Worktree and project management, sidebar          |
| `component:files`     | Project files explorer and Others folders         |
| `component:browser`   | Browser panels                                    |
| `component:lsp`       | Language servers and diagnostics                  |
| `component:agent`     | Coding agent panel                                |
| `component:layout`    | Panels, tabs, dockview, top bar                   |
| `component:keyboard`  | Shortcuts, focus navigation, accessibility        |
| `component:cli`       | loxel CLI                                         |
| `component:electron`  | Packaging, native shell, updates, passkeys        |
| `component:server`    | Watchers, WebSocket, state sync, server lifecycle |
| `component:settings`  | Settings and preferences                          |
| `component:ci`        | CI and release workflows                          |
| `component:docs`      | Documentation                                     |
| `component:tests`     | Test coverage and flakiness                       |

Examples:

- A diff viewer that mis-highlights moved lines: `fix`, `package:loxel`, `component:diff`
- A new `wt` subcommand: `feat`, `package:wt`
- Flaky CI on the release workflow: `chore`, `package:repo`, `component:ci`, `component:tests`

The `dependencies`, `javascript`, and `github_actions` labels are applied by Dependabot to its pull requests and are not part of the issue scheme.
