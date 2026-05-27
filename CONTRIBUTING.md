# Contributing

## Getting Started

```bash
# Install dependencies
pnpm install

# Set up git hooks (runs automatically via prepare script)
pnpm run prepare
```

Copy `.env.example` to `.env` and fill in the required values.

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

See [CLAUDE.md](CLAUDE.md) for detailed architecture documentation.

## Pull Requests

- Keep PRs focused — one feature or fix per PR
- Run `pnpm run lint:fix && pnpm run fmt` before pushing
- Ensure `pnpm run typecheck` passes for affected packages
- Tests must pass: `pnpm -C packages/<package> run test`

## Reporting Issues

Use [GitHub Issues](../../issues) for bugs and feature requests. For security vulnerabilities, see [SECURITY.md](SECURITY.md).
