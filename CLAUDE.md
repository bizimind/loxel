# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

loxel is a monorepo (pnpm for package management, Bun for runtime) containing packages that extend Claude Code's capabilities for agent-friendly development workflows. The packages intercept and adapt standard tools (like Git) for non-blocking agent execution while preserving normal UX for humans.

## Environment Setup

This project uses [direnv](https://direnv.net/) to automatically load environment variables from the root `.env` file into your shell. All package.json scripts and application code can assume env vars (API tokens, service URLs, device IDs, etc.) are available via `process.env` and shell expansion.

```bash
brew install direnv
echo 'eval "$(direnv hook zsh)"' >> ~/.zshrc   # or bash/fish equivalent
direnv allow                                    # trust the .envrc in this repo
```

The `.env` file is copied to the worktree root by `wt add` hooks (source: `.wt-local-res/.env`). There is a single root `.env` — packages do not have their own `.env` files.

## Build Commands

```bash
pnpm install                                   # Install all dependencies

# Build individual packages (all packages with build scripts)
bun run --cwd packages/cc-git-editor build
bun run --cwd packages/cc-tool-guard build
bun run --cwd packages/whisper-cpp build
bun run --cwd packages/wt build

# Lint and format (root-level)
bun run lint                                   # Run oxlint
bun run lint:fix                               # Fix lint issues
bun run fmt                                    # Format with oxfmt
bun run fmt:check                              # Check formatting

# Type checking
bun run typecheck                              # All packages (parallel)
bun run --cwd packages/<package> typecheck     # Single package
```

## Testing

```bash
bun run --cwd packages/<package> test          # Run all tests in package (uses package.json script)

# Run a single test file
bun test packages/wt/src/config/schema.test.ts

# Run tests matching a pattern
bun test --cwd packages/wt --test-name-pattern "validates"
```

## Architecture

### Packages

#### CLI Tools & Binaries

- **cc-git-editor**: Intercepts `git rebase -i` and `git add -p` to provide non-blocking execution for agents. Entry point: `src/git-wrapper.ts`. Detects agent mode via `CLAUDECODE=1` env var.

- **cc-tool-guard**: Permission request hook that evaluates Bash/Read operations for safety. Uses pattern matching (`src/evaluator/patterns.ts`) with Haiku fallback for uncertain cases.

- **excalidraw**: CLI for agents to create, edit, and view Excalidraw diagrams. Provides batch operations via JSON-over-stdin for atomic multi-element mutations (draw, move, resize, edit, group). Uses jsdom DOM shim for headless element creation via `@excalidraw/element`. Entry point: `src/cli.ts`.

- **wt**: Git worktree manager CLI for parallel development. Handles automatic port offsetting, unique resource naming (Docker containers, databases), and lifecycle hooks. Config via `wt.yaml`.

#### Libraries

- **channel**: WebSocket channel client library for peer-to-peer communication via relay. Supports JSON and binary messages, auto-reconnection with exponential backoff, ACK-based reliability with retries, and backpressure handling. Entry point: `src/index.ts`.

- **cli-common**: Shared CLI utilities for consistent command-line interfaces. Provides `CommandResult<T>` pattern with `runAction()` for type-safe output handling (json/human/quiet modes), formatters (`formatTable`, `formatKeyValue`, `formatStatus`), centralized `OutputContext` for progress logging, and the update system for self-updating binaries. Used by wt, excalidraw, coding-agent.

- **logger**: Shared structured logging library with Axiom integration. Provides error serialization with cause chain traversal, sensitive data filtering, and string truncation. Entry point: `src/index.ts`. Used by channel-worker, cli-common, coding-agent, loxel.

- **whisper-cpp**: Node addon wrapping whisper.cpp for speech-to-text. Native C++ bindings built with cmake-js.

#### Backend Services

- **channel-worker**: Cloudflare Worker for WebSocket channel relay using Durable Objects. JWT auth via WorkOS JWKS with RS256 verification. Enforces same-user channels (all clients must share the same JWT `sub` claim). Entry point: `src/index.ts`. Config via `WORKOS_CLIENT_ID` env var. Deployed via `release-channel-worker.yml` workflow.

### Key Patterns

**Agent Detection**: Check `CLAUDECODE=1` environment variable to branch between agent (non-blocking) and human (standard) behavior.

**Standalone Binaries**: Packages compile to standalone executables via `bun build --compile`. Production binaries are built and signed in CI and placed in `~/.local/bin/`. If specifically requested to use a locally built binary, copy it to `~/.local/bin/` and ad-hoc sign with `codesign -s -` (required on macOS or the binary gets SIGKILL'd).

**Hook Protocol**: Tools integrate with Claude Code via JSON-over-stdin/stdout. See `cc-tool-guard/src/tool-guard.ts` for the pattern.

## Bun Guidelines

**pnpm** is the package manager (`pnpm install`, `pnpm-lock.yaml`). **Bun** is the runtime (`bun run`, `bun test`, `bun build`). Do not use `bun install` or `bun add` for dependency management.

Use Bun's native APIs and avoid external npm dependencies when Bun provides alternatives:

- `Bun.serve()` for HTTP/WebSocket (not express)

- `bun:sqlite` for SQLite (not better-sqlite3)

- `Bun.file()` for file I/O (not fs.readFile when reading files)

- `Bun.$` for shell commands (not execa)

- `bun test` for testing (not jest/vitest)

**Node.js built-in modules are allowed**: You can use Node.js standard library modules (e.g. `node:path`, `node:os`, `node:crypto`, etc.) when they provide functionality not available in Bun's APIs or when they're more appropriate for the task. The guideline is to prefer Bun-native APIs over external npm packages, not to avoid Node.js built-ins.

## Code & Architecture Quality Standards

These are repository-wide standards. Existing violations are technical debt and should be corrected whenever code in that area is changed.

### DRY and Abstraction Discipline

- Keep one source of truth for shared behavior, schemas, and constants.

- Do not introduce abstractions before there is real duplication or a clear domain boundary.

- Prefer small, cohesive modules with clear responsibilities over cross-cutting utility sprawl.

### Type Safety Standards

- Do not use `any` in application code.

- Prefer runtime checks or parsers over `as` for external/untyped data. Inline `as` is acceptable when the type is already structurally guaranteed by surrounding code.

- Treat external/untyped data as `unknown` first, then narrow via type guards or schema parsing.

- Prefer explicit narrowing and exhaustive handling over implicit assumptions.

### Type Definition Placement

- Do not create generic catch-all `types.ts` files.

- Define types next to the code that owns them.

- If multiple modules share a type, place it in the closest shared domain module with a specific filename (for example, `session-model.ts`, `protocol-schema.ts`), not `types.ts`.

- Keep runtime schemas and inferred TypeScript types colocated when possible.

### Type Reuse and Derivation

- Reuse existing types instead of duplicating near-identical shapes.

- Derive related types from canonical sources (`z.infer`, `Pick`, `Omit`, `Exclude`, etc.).

- Make one canonical type/schema authoritative; derive request/response/partial variants from it.

### Module Organization and Public Boundaries

- Organize files by domain/feature, not by broad technical buckets disconnected from behavior.

- Prefer predictable module boundaries and public methods over reaching into internals.

- Do not rely on private hooks/internal methods/workarounds across modules.

### Export and Import Hygiene

- Export symbols from the file where they are defined.

- Barrel `index.ts` files: allowed at package roots and domain module boundaries (folders with a clear public API), not arbitrary subfolders.

- Outside a barrel-exporting folder, import only through its barrel — never bypass it to import internal files. Within the folder, import siblings directly.

- Avoid other re-export chains.

### Control Flow and Readability

- Prefer guard clauses and early return/throw to reduce nesting.

- Keep happy-path logic flat and obvious.

- Favor straightforward, intention-revealing code over clever shortcuts.

- Optimize for maintainability and ease of review.

### Error Handling and Observability

- Handle recoverable errors gracefully with clear user/developer-visible context.

- Fail fast for unrecoverable states with explicit errors.

- Preserve original error causes where possible.

- Ensure failures are observable (structured logs/context) without leaking sensitive data.

### Documentation Coupling

- Behavior changes must update the nearest README/spec/docs in the same PR.

### Solution Simplicity and Tradeoff Clarity

- Always evaluate the simplest, purest solution that can satisfy the requirements.

- Prefer reusing existing patterns, modules, and components over introducing new systems.

- Prefer minimal, focused changes that reduce complexity and long-term maintenance burden.

- If requirements create significant complexity, explicitly propose simpler alternatives and explain tradeoffs.

- Never ignore, drop, or weaken user requirements without explicit user agreement first.

## Linting & Formatting

**Linter**: oxlint with plugins: `oxc`, `typescript`, `react`, `react-perf`. Categories `correctness`, `suspicious`, `pedantic`, `perf`, `restriction`, `nursery` set to error; `style` off. The `wt` package additionally enforces `no-console: error`.

**Formatter**: oxfmt with 100-char print width, 2-space indentation, trailing commas, Tailwind CSS class sorting (via `cn` function), and auto-sorted imports.

**Pre-commit hook**: The `.githooks/pre-commit` hook runs automatically on commit — it formats code (`bun run fmt`), re-stages formatted files, runs lint (`bun run lint`), and runs typecheck (`bun run typecheck`). Configured via `"prepare": "git config core.hooksPath .githooks"` in root package.json.

## Type Checking

Type checking uses `tsgo` (`@typescript/native-preview`) — the native TypeScript compiler — instead of `tsc`. All package `typecheck` scripts run `tsgo --noEmit`. The root `bun run typecheck` runs all packages in parallel via `bun run --filter '*' typecheck`.

Note: `tsgo` does not support the `baseUrl` tsconfig option (it was removed). Use `paths` with relative prefixes instead.

## CI & Releases

**CI**: Every push runs change detection to find affected packages (direct changes + transitive dependents via workspace dependency graph). Only affected packages run `test`, `build`, and `typecheck` in parallel matrix jobs. Root config changes trigger targeted checks: `tsconfig*.json` → typecheck all, `.oxlintrc.jsonc`/`.oxfmtrc.jsonc` → lint all, root `package.json` → everything. Lint/format runs only when code or lint config changed. Automated code review via Claude runs on PRs (`claude-code-review.yml`).

**Auto-releases**: `wt` has automatic releases triggered when changes to its package directory are merged to main:

1. Bumps patch version in package.json
2. Creates a release commit (`chore(<pkg>): release vX.Y.Z`) and tag
3. Builds binaries
4. Uploads binaries directly to R2 (`https://loxel.bizimind.io/<pkg>/`)
5. Creates GitHub release with R2 download links (no binary attachments)

**Deployments**: `channel-worker` has a dedicated deploy workflow (`release-channel-worker.yml`).

**Version checking**: When debugging CLI issues, verify the user has the latest version. Check the manifest at `https://loxel.bizimind.io/<pkg>/manifest.json` for current version and compare with local binary. Don't manually bump versions - releases are automated.

## Workflow

When asked to implement a feature, fix a bug, or execute a plan, the expected deliverable is a PR. After completing implementation:

1. Run `bun run lint:fix` and `bun run fmt`

2. Run `typecheck` and `test` for affected packages

3. Verify the solution works

4. Task two sub agents in parallel:
   - **Code review**: review your changes for correctness, quality, and security (provide full context: the task, files changed, and relevant architecture)

   - **Follow-up ideas**: explore feature ideas, improvements, or optimizations related to the current work — file GitHub issues for worthwhile ones

5. Fix review findings directly in the PR. Only create GitHub issues for items that are clearly out of scope and low urgency (e.g., a broader refactor or a pattern change affecting many files).

6. Commit changes and create a PR

For follow-up changes after a PR is created: first check if the PR was merged. If merged, fetch main, checkout a new branch from main, make changes, and create a new PR. If the PR is still open, add new commits to the existing branch.
