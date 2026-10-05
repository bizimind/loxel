# Sandbox image

A reference agent-friendly image is defined in [`images/`](../images/) and built with `docker buildx bake`. The [sandbox SDK](../README.md) doesn't require it — any OCI image works.

```bash
cd packages/sandbox/images
docker buildx bake sandbox --set '*.platform=linux/<arch>' --load
# image tag: ghcr.io/bizimind/loxel/sandbox:latest
```

## Baked tools (version-pinned via `docker-bake.hcl`)

Each tool is fetched with an SHA256 checksum and composed into the final image as `/usr/local/bin/<tool>`:

| Category            | Tools                                                                                  |
| ------------------- | -------------------------------------------------------------------------------------- |
| Code search / files | `rg` (ripgrep), `fd`, `bat`, `fzf`, `jq`                                               |
| Languages           | `python3` + `pip` (python-build-standalone), `go`, `node` + `npm`, `pnpm`, `bun`, `uv` |
| Cloud / infra       | `aws` (aws-cli), `terraform`, `kubectl`, `helm`                                        |
| Source / CI         | `git` (baked), `gh`                                                                    |
| Env / workflow      | `direnv`                                                                               |
| Agents              | `claude`, `codex`                                                                      |

## Apt-installed utilities

Stable OS utilities with no agent-level version sensitivity: `perl`, `less`, `libcurl3-gnutls`, `tree`, `wget`, `unzip`, `make`, `gcc`, `g++`, `zsh`, `openssh-client`, `gnupg`.

## Shell

Bash is the default `CMD`. Zsh + Oh My Zsh (theme `robbyrussell`, plugins `(git fzf)`) is installed system-wide at `/opt/oh-my-zsh` and opt-in via `zsh -l`. Oh My Zsh is pinned to a specific upstream commit for reproducibility.

## Environment variables

| Variable           | Value                                 | Why                                                                             |
| ------------------ | ------------------------------------- | ------------------------------------------------------------------------------- |
| `PATH`             | `/usr/local/bin:/usr/local/go/bin:…`  | Exposes baked binaries and Go toolchain.                                        |
| `ZSH`              | `/opt/oh-my-zsh`                      | Oh My Zsh framework root.                                                       |
| `GIT_EXEC_PATH`    | `/usr/local/lib/git-core`             | The baked git layout lives under `/usr/local`; without this, HTTPS clones fail. |
| `GIT_TEMPLATE_DIR` | `/usr/local/share/git-core/templates` | Same rationale — `git init` picks up the correct default templates.             |

## Updating versions

Bump the relevant `<TOOL>_VERSION` and `<TOOL>_SHA256_{AMD64,ARM64}` variables at the top of `docker-bake.hcl`. Checksums are taken from upstream release artifacts (preferred) or computed directly when no checksum file is published.

## Smoke test

`tests/sandbox-image.test.ts` runs each baked tool inside a container via the SDK. It needs a ready container runtime with the image loaded. Override the image with `SANDBOX_IMAGE` and force a provider with `SANDBOX_PROVIDER` (`apple`, `podman`, or `docker`).
