# loxel

**Loxel** is the professional workspace for AI-powered development. Run Claude Code, Codex, or any terminal agent on as many parallel tasks as the work needs. Every task keeps its own worktree, terminals, browser tabs, editors, and layout; you orchestrate them from one window and open the code whenever you need to own what ships. [Download it and read the docs at bizimind.io](https://bizimind.io).

This monorepo (pnpm + Bun) holds the app in [packages/loxel](packages/loxel), its site and docs, and the CLI tools, libraries, and services that support agent-driven development workflows.

## Packages

| Package                                         | Description                                                                                                    |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| [cc-git-editor](packages/cc-git-editor)         | Agent-friendly git commands that intercept `git rebase -i` and `git add -p` for non-blocking execution         |
| [channel](packages/channel)                     | WebSocket client library and wire protocol for peer-to-peer messaging via relay                                |
| [channel-worker](packages/channel-worker)       | Cloudflare Worker relay for WebSocket channels (Durable Objects, WorkOS JWT auth)                              |
| [cli-common](packages/cli-common)               | Shared CLI utilities: output modes, formatters, logging, self-update                                           |
| [code-analysis](packages/code-analysis)         | Code analysis CLI with live treemap and import-graph visualizations                                            |
| [excalidraw](packages/excalidraw)               | CLI for agents to create, edit, query, and render Excalidraw diagrams                                          |
| [localdb-sdk](packages/localdb-sdk)             | SQLite-backed structured database SDK with typed columns, views, and formulas                                  |
| [logger](packages/logger)                       | Structured Axiom logging with error serialization and sensitive-data redaction                                 |
| [loxel](packages/loxel)                         | The workspace: Electron desktop app plus Bun server for running parallel, task-scoped AI coding work           |
| [monaco-lsp-client](packages/monaco-lsp-client) | Monaco editor LSP client (fork of `@vscode/monaco-lsp-client`)                                                 |
| [sandbox](packages/sandbox)                     | Provider-agnostic container SDK for Apple Containers, Podman, and Docker, plus a reference agent sandbox image |
| [site](packages/site)                           | Astro website and user docs for loxel (bizimind.io)                                                            |
| [whisper-cpp](packages/whisper-cpp)             | Node addon wrapping whisper.cpp for local speech-to-text                                                       |
| [wt](packages/wt)                               | Configless Git worktree manager with repo-root setup, teardown, and rename hooks                               |

Agent skills for Loxel users, to install in your own coding agent, are in [skills](skills).

## Installation

```bash
pnpm install
```

## Development

```bash
# Build a package
pnpm -C packages/<package> run build

# Run tests
pnpm -C packages/<package> run test

# Lint and format
pnpm run lint
pnpm run fmt
```

See [AGENTS.md](AGENTS.md) for repo-wide setup, commands, standards, and the package index, and [CONTRIBUTING.md](CONTRIBUTING.md) for the PR workflow. Each package README documents that package.

## License

[FSL-1.1-ALv2](LICENSE) — source available for non-competing use; converts to Apache 2.0 after 2 years.
