# Contributing

## Getting Started

```bash
# Install dependencies
pnpm install

# Set up git hooks (runs automatically via prepare script)
bun run prepare
```

Copy `.env.example` to `.env` and fill in the required values.

## Development

```bash
# Build a package
bun run --cwd packages/<package> build

# Run tests
bun test --cwd packages/<package>

# Type check
bun run --cwd packages/<package> typecheck

# Lint and format
bun run lint
bun run fmt
```

See [CLAUDE.md](CLAUDE.md) for detailed architecture documentation.

## Pull Requests

- Keep PRs focused — one feature or fix per PR
- Run `bun run lint:fix && bun run fmt` before pushing
- Ensure `bun run typecheck` passes for affected packages
- Tests must pass: `bun run --cwd packages/<package> test`

## Reporting Issues

Use [GitHub Issues](../../issues) for bugs and feature requests. For security vulnerabilities, see [SECURITY.md](SECURITY.md).
