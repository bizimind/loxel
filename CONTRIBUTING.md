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
