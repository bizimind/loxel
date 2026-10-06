# loxel

A monorepo (pnpm + Bun) built around [Loxel](packages/loxel), an IDE for the agentic coding era, together with the CLI tools, libraries, and services that support agent-driven development workflows.

## Packages

| Package                                         | Description                                                                                                    |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| [cc-git-editor](packages/cc-git-editor)         | Agent-friendly git commands that intercept `git rebase -i` and `git add -p` for non-blocking execution         |
| [cc-tool-guard](packages/cc-tool-guard)         | Permission request hook that auto-approves safe Bash/Read operations using pattern matching                    |
| [channel](packages/channel)                     | WebSocket client library and wire protocol for peer-to-peer messaging via relay                                |
| [channel-worker](packages/channel-worker)       | Cloudflare Worker relay for WebSocket channels (Durable Objects, WorkOS JWT auth)                              |
| [cli-common](packages/cli-common)               | Shared CLI utilities: output modes, formatters, logging, self-update                                           |
| [code-analysis](packages/code-analysis)         | Code analysis CLI with live treemap and import-graph visualizations                                            |
| [coding-agent](packages/coding-agent)           | Coding agent runtime (SDK + stdio JSON protocol) with tools, plan mode, approvals, and persistent sessions     |
| [excalidraw](packages/excalidraw)               | CLI for agents to create, edit, query, and render Excalidraw diagrams                                          |
| [localdb-sdk](packages/localdb-sdk)             | SQLite-backed structured database SDK with typed columns, views, and formulas                                  |
| [logger](packages/logger)                       | Structured Axiom logging with error serialization and sensitive-data redaction                                 |
| [loxel](packages/loxel)                         | The IDE: Electron desktop app plus Bun server for agentic, multi-worktree development                          |
| [monaco-lsp-client](packages/monaco-lsp-client) | Monaco editor LSP client (fork of `@vscode/monaco-lsp-client`)                                                 |
| [sandbox](packages/sandbox)                     | Provider-agnostic container SDK for Apple Containers, Podman, and Docker, plus a reference agent sandbox image |
| [site](packages/site)                           | Astro website and user docs for loxel (bizimind.io)                                                            |
| [whisper-cpp](packages/whisper-cpp)             | Node addon wrapping whisper.cpp for local speech-to-text                                                       |
| [wt](packages/wt)                               | Configless Git worktree manager with repo-root setup, teardown, and rename hooks                               |

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
