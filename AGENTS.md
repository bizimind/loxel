# AGENTS.md

This file provides guidance to coding agents working in this repository (`CLAUDE.md` is a symlink to it). It is an index: it covers repo-wide setup, commands, and standards, and points to package READMEs for everything package-specific.

## Project Overview

loxel is a monorepo (pnpm for package management, Bun for runtime) built around **Loxel**, an IDE for agentic coding (`packages/loxel`, Electron app plus Bun server), its docs site (`packages/site`), and a set of CLI tools, libraries, and services that support agent-driven development workflows: a configless worktree manager (`wt`), Claude Code hooks and wrappers that make standard tools non-blocking for agents while preserving normal UX for humans, and shared libraries for logging, CLI output, and WebSocket channels.

## Environment Setup

This project uses [direnv](https://direnv.net/) to automatically load environment variables from the root `.env` file into your shell. All package.json scripts and application code can assume env vars (API tokens, service URLs, device IDs, etc.) are available via `process.env` and shell expansion.

```bash
brew install direnv
echo 'eval "$(direnv hook zsh)"' >> ~/.zshrc   # or bash/fish equivalent
direnv allow                                    # trust the .envrc in this repo
```

The `.env` file is copied to the worktree root by the repo-root `init.wt.sh` hook that `wt add` runs (source: `.wt-local-res/.env`). There is a single root `.env` — packages do not have their own `.env` files.

## Build Commands

```bash
pnpm install                                   # Install all dependencies

# Build a package (root `build` is intentionally disabled; packages with a build script:
# cc-git-editor, cc-tool-guard, code-analysis, coding-agent, excalidraw, loxel, site, whisper-cpp, wt)
pnpm -C packages/<package> run build

# Lint and format (root-level, or from any package via aliases)
pnpm run lint                                  # Run oxlint
pnpm run lint:fix                              # Fix lint issues
pnpm run fmt                                   # Format with oxfmt
pnpm run fmt:check                             # Check formatting

# Type checking
pnpm run typecheck                             # All packages (parallel)
pnpm -C packages/<package> run typecheck       # Single package
```

## Testing

```bash
pnpm -C packages/<package> run test            # Run all tests in package (uses package.json script)

# Run a single test file (bun test runner directly; --cwd loads that package's bunfig.toml)
bun test --cwd packages/wt src/git/name.test.ts

# Run tests matching a pattern
bun test --cwd packages/wt --test-name-pattern "validates"
```

## Architecture

### Packages

Each package README is the authoritative doc for that package; this list only orients. Package READMEs link down to their nested docs and specs where they exist.

#### Apps

- **loxel**: The IDE itself (Electron app plus Bun server). User-facing feature docs are the site pages under `packages/site/src/content/docs/`; update those, not the loxel README, when user-visible behavior changes. See `packages/loxel/README.md`.

- **site**: Astro site for bizimind.io (landing page, downloads, user docs), deployed to Cloudflare Pages. See `packages/site/README.md`.

#### CLI Tools & Binaries

- **wt**: Configless git worktree manager CLI (`add`/`list`/`view`/`mv`/`remove`, repo-root `init.wt.sh`/`clean.wt.sh`/`rename.wt.sh` hooks). Read `packages/wt/README.md` or the `wt` skill before working on it.

- **cc-git-editor**: Intercepts `git rebase -i` and `git add -p` to provide non-blocking execution for agents. Detects agent mode via `CLAUDECODE=1`. See `packages/cc-git-editor/README.md`.

- **cc-tool-guard**: PermissionRequest hook that auto-approves safe Bash/Read operations and defers everything else to the user (never denies), using pattern matching with a Haiku fallback. See `packages/cc-tool-guard/README.md`.

- **excalidraw**: CLI for agents to create, edit, query, and render Excalidraw diagrams, with JSON-over-stdin batch operations. See `packages/excalidraw/README.md` and the `excalidraw` skill.

- **code-analysis**: Code analysis CLI with built-in plugins (loc, languages, git-churn, lint/type issues, import graph) that prints results or serves a live treemap or graph visualization. See `packages/code-analysis/README.md`.

- **coding-agent**: Programmatic coding agent runtime used by loxel's agent panel (in-process `Session` SDK, or a stdio JSON protocol CLI). See `packages/coding-agent/README.md`.

#### Libraries

- **channel**: WebSocket client library for peer-to-peer messaging through the channel-worker relay; owns the shared wire protocol. See `packages/channel/README.md`.

- **cli-common**: Shared CLI plumbing (`CommandResult`/`runAction` output modes, formatters, logging, self-update) used by wt, excalidraw, coding-agent, and code-analysis. See `packages/cli-common/README.md`.

- **logger**: Axiom-backed structured logger with error-cause serialization and sensitive-data redaction. See `packages/logger/README.md` and the `logs` skill.

- **localdb-sdk**: SQLite-backed (`bun:sqlite`) structured database SDK with typed columns, views, and formulas; powers loxel's local databases. See `packages/localdb-sdk/README.md`.

- **monaco-lsp-client**: Monaco LSP client forked from `@vscode/monaco-lsp-client`, used by loxel's editor. See `packages/monaco-lsp-client/README.md`.

- **sandbox**: Provider-agnostic container SDK (Apple Containers, Podman, Docker) plus a reference agent sandbox image. See `packages/sandbox/README.md`.

- **whisper-cpp**: Node addon wrapping whisper.cpp for local speech-to-text, built with cmake-js. See `packages/whisper-cpp/README.md`.

#### Backend Services

- **channel-worker**: Cloudflare Worker (Durable Objects) that relays channel WebSocket traffic, with WorkOS JWT auth and same-user channels. See `packages/channel-worker/README.md`.

### Key Patterns

**Agent Detection**: Check `CLAUDECODE=1` environment variable to branch between agent (non-blocking) and human (standard) behavior.

**Standalone Binaries**: Packages compile to standalone executables via `bun build --compile`. Production binaries are built and signed in CI and placed in `~/.local/bin/`. If specifically requested to use a locally built binary, copy it to `~/.local/bin/` and ad-hoc sign with `codesign -s -` (required on macOS or the binary gets SIGKILL'd).

**Hook Protocol**: Tools integrate with Claude Code via JSON-over-stdin/stdout. See `cc-tool-guard/src/tool-guard.ts` for the pattern.

## Bun Guidelines

**pnpm** is the package manager and script runner (`pnpm install`, `pnpm run <script>`, `pnpm -C <path> run <script>`). **Bun** is the runtime only — compiler (`bun build`), test runner (`bun test`), and TS execution (`bun <file.ts>`). Do not use `bun install`, `bun add`, or `bun run <script-name>` for dependency management or script invocation.

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

### Documentation

- Docs use progressive disclosure: this file is an index pointing to package READMEs, and a large package's README (e.g. `packages/loxel`) is in turn an index pointing to its nested docs and specs.

- In every PR, check that the docs covering the code you changed are not stale, and fix them in the same PR if they are.

- READMEs stay high-level and user-facing: what the package does, setup, commands, configuration, public APIs.

- Internal docs (nested docs and specs linked from the README) cover architecture, patterns and conventions, and design choices with their rationale.

- Add or expand docs only for significant changes. Write them at the most specific relevant level and link to them from the parent index instead of repeating the detail there.

- Explain small fixes and local implementation details in code comments next to the code, not in docs.

### Solution Simplicity and Tradeoff Clarity

- Always evaluate the simplest, purest solution that can satisfy the requirements.

- Prefer reusing existing patterns, modules, and components over introducing new systems.

- Prefer minimal, focused changes that reduce complexity and long-term maintenance burden.

- If requirements create significant complexity, explicitly propose simpler alternatives and explain tradeoffs.

- Never ignore, drop, or weaken user requirements without explicit user agreement first.

## Linting & Formatting

**Linter**: oxlint with plugins: `oxc`, `typescript`, `react`, `react-perf`. Categories `correctness`, `suspicious`, `pedantic`, `perf`, `restriction`, `nursery` set to error; `style` off. The `wt` package additionally enforces `no-console: error`.

**Formatter**: oxfmt with 100-char print width, 2-space indentation, trailing commas, Tailwind CSS class sorting (via `cn` function), and auto-sorted imports.

**Pre-commit hook**: The `.githooks/pre-commit` hook runs automatically on commit — it formats code (`pnpm run fmt`), re-stages formatted files, runs lint (`pnpm run lint`), and runs typecheck (`pnpm run typecheck`). Configured via `"prepare": "git config core.hooksPath .githooks"` in root package.json.

## Type Checking

Type checking uses the official TypeScript 7 native compiler (`@typescript/native`) via `tsc`.
Regular TypeScript package `typecheck` scripts run `tsc --noEmit`; the site runs `astro check`.
The root `pnpm run typecheck` invokes each workspace's script in parallel via
`pnpm -r --parallel run typecheck`.

## CI & Releases

**CI**: Every push runs change detection to find affected packages (direct changes + transitive dependents via workspace dependency graph). Only affected packages run `test`, `build`, and `typecheck` in parallel matrix jobs. Root config changes trigger targeted checks: `tsconfig*.json` → typecheck all, `.oxlintrc.jsonc`/`.oxfmtrc.jsonc` → lint all, root `package.json` → everything. Lint/format runs only when code or lint config changed. Automated code review via Claude runs on PRs (`claude-code-review.yml`).

**Auto-releases**: `wt`, `code-analysis`, and `loxel` release automatically when changes under their package directory are merged to main (`release-<pkg>.yml`; `loxel` also supports `workflow_dispatch` for releases driven by root-level changes):

1. Bumps patch version in package.json
2. Creates a release commit (`chore(<pkg>): release vX.Y.Z`) and tag
3. Builds binaries
4. Uploads binaries and a `manifest.json` to R2 (`https://loxel.bizimind.io/<pkg>/`)
5. Creates a GitHub release with R2 download links (no binary attachments)

**Deployments**: `channel-worker` deploys via `release-channel-worker.yml`. The docs site deploys via `release-site.yml` on pushes touching `packages/site` (preview per branch, production from main) and is re-dispatched after each `loxel` release so the download page picks up the new manifest.

**Version checking**: When debugging CLI issues, verify the user has the latest version. Check the manifest at `https://loxel.bizimind.io/<pkg>/manifest.json` for current version and compare with local binary. Don't manually bump versions - releases are automated.

## Workflow

When asked to implement a feature, fix a bug, or execute a plan, the expected deliverable is a PR. After completing implementation:

1. Run `pnpm run lint:fix` and `pnpm run fmt`

2. Run `typecheck` and `test` for affected packages

3. Verify the solution works

4. Task two sub agents in parallel:
   - **Code review**: review your changes for correctness, quality, and security (provide full context: the task, files changed, and relevant architecture)

   - **Follow-up ideas**: explore feature ideas, improvements, or optimizations related to the current work — file GitHub issues for worthwhile ones

5. Fix review findings directly in the PR. Only create GitHub issues for items that are clearly out of scope and low urgency (e.g., a broader refactor or a pattern change affecting many files).

6. Commit changes and create a PR

For follow-up changes after a PR is created: first check if the PR was merged. If merged, fetch main, checkout a new branch from main, make changes, and create a new PR. If the PR is still open, add new commits to the existing branch.
