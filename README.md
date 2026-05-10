# loxel

A Bun monorepo containing packages that extend Claude Code's capabilities for agent-friendly development workflows.

## Packages

| Package                                         | Description                                                                                            |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| [cc-git-editor](packages/cc-git-editor)         | Agent-friendly git commands that intercept `git rebase -i` and `git add -p` for non-blocking execution |
| [cc-tool-guard](packages/cc-tool-guard)         | Permission request hook that auto-approves safe Bash/Read operations using pattern matching            |
| [channel](packages/channel)                     | WebSocket client library for peer-to-peer communication via relay                                      |
| [channel-worker](packages/channel-worker)       | Cloudflare Worker relay server for WebSocket channels                                                  |
| [cli-common](packages/cli-common)               | Shared CLI utilities for consistent command-line interfaces                                            |
| [coding-agent](packages/coding-agent)           | Orchestrator for multi-step coding agent sessions                                                      |
| [excalidraw](packages/excalidraw)               | CLI for agents to create, edit, and view Excalidraw diagrams                                           |
| [logger](packages/logger)                       | Shared structured logging library with Axiom integration                                               |
| [loxel](packages/loxel)                         | Electron-based desktop app for code review and repository exploration                                  |
| [monaco-lsp-client](packages/monaco-lsp-client) | Monaco editor LSP client adapter                                                                       |
| [sandbox](packages/sandbox)                     | Docker-based sandbox environments for isolated code execution                                          |
| [whisper-cpp](packages/whisper-cpp)             | Node addon wrapping whisper.cpp for speech-to-text                                                     |
| [wt](packages/wt)                               | Git worktree manager with automatic port offsetting, unique naming, and lifecycle hooks                |

## Installation

```bash
bun install
```

## Development

```bash
# Build a package
bun run --cwd packages/<package> build

# Run tests
bun test --cwd packages/<package>

# Lint and format
bun run lint
bun run fmt
```

See [CLAUDE.md](CLAUDE.md) for detailed architecture and development workflow documentation.

## License

[FSL-1.1-ALv2](LICENSE) — source available for non-competing use; converts to Apache 2.0 on May 10, 2028.
