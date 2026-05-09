# sandbox

Provider-agnostic container SDK for running isolated workloads in Apple Containers, Docker, or Podman. The SDK consumes images; it does not build them.

## Core concepts

- **`SandboxSpec`** — a declarative, Zod-validated description of a container. Immutable after parse.
- **`SandboxTemplate`** — a `(spec, provider)` pair. Stateless w.r.t. running containers.
  - `create()` starts a new container from the spec.
  - `attach()` binds to an existing container by name or ID.
  - `find()` lists SDK-managed containers matching a label filter.
- **`Sandbox`** — a live container handle returned by `create()` / `attach()` / `find()`.

All sandboxes created via the SDK are tagged with the baseline label `sandbox.sdk=bizimind`. `find()` always filters by this label, so the SDK never hands back containers it didn't create.

## Quick start

```ts
import { SandboxTemplate } from "sandbox";

const template = new SandboxTemplate({
  name: "my-sandbox",
  image: "ubuntu:24.04",
  command: ["sleep", "infinity"],
});

const sandbox = await template.create();
const result = await sandbox.exec(["echo", "hello"]);
console.log(result.stdout); // "hello\n"
await sandbox.destroy();
```

## SandboxSpec

| Field          | Type                     | Default    | Notes                                                            |
| -------------- | ------------------------ | ---------- | ---------------------------------------------------------------- |
| `name`         | `string`                 | _required_ | Name (used as prefix when `create()` auto-suffixes).             |
| `image`        | `string`                 | _required_ | OCI image reference.                                             |
| `command`      | `string[]`               | image CMD  | Overrides the image command.                                     |
| `env`          | `Record<string, string>` | `{}`       | Environment variables.                                           |
| `workdir`      | `string`                 | -          | Working directory inside the container.                          |
| `user`         | `string`                 | -          | `"uid:gid"` or `"name"`.                                         |
| `hostname`     | `string`                 | -          | Container hostname.                                              |
| `network`      | `string`                 | -          | `"host"`, `"none"`, or a named network.                          |
| `volumes`      | `Volume[]`               | `[]`       | Bind mounts.                                                     |
| `ports`        | `PortMapping[]`          | `[]`       | Published ports.                                                 |
| `labels`       | `Record<string, string>` | `{}`       | Merged with `sandbox.sdk=bizimind`.                              |
| `resources`    | `{cpus?, memory?}`       | -          | `cpus` fractional, `memory` like `"512m"`/`"2g"`.                |
| `autoRemove`   | `boolean`                | `false`    | Remove on exit.                                                  |
| `providerArgs` | `string[]`               | `[]`       | Raw CLI args appended before the image reference (escape hatch). |

```ts
// Volume
{ host: "/path/on/host", container: "/path/in/container", readonly: false }

// PortMapping — host: 0 auto-assigns; protocol defaults to "tcp"
{ host: 8080, container: 80, protocol: "tcp" }
```

## SandboxTemplate

```ts
const template = new SandboxTemplate(spec, { providerType: "docker" });
// or inject a provider instance directly:
const template = new SandboxTemplate(spec, { provider: myProvider });
```

Auto-detection prefers **Apple Containers > Podman > Docker** (first available).

### `create(overrides?)`

Create and start a new container. All spec fields can be overridden:

- `env`, `labels`: shallow-merged
- `volumes`, `ports`: appended
- everything else: replaced

By default the final container name is `<spec.name>-<random>` — pass an explicit `name` override to use an exact name.

```ts
const template = new SandboxTemplate({ name: "worker", image: "node:22", env: { ROLE: "worker" } });
const s1 = await template.create({ env: { SHARD: "0" } }); // worker-a1b2c3d4
const s2 = await template.create({ name: "worker-fixed" }); // worker-fixed
```

### `attach(nameOrId)`

Bind to an existing container. Throws `ContainerNotFoundError` if absent.

```ts
const name = sandbox.name; // e.g. "worker-a1b2c3d4"
// ... process restarts ...
const restored = await template.attach(name);
await restored.exec(["echo", "still here"]);
```

### `find({ label? })`

List SDK-managed sandboxes, optionally filtered by labels (ANDed). The baseline `sandbox.sdk=bizimind` label is always applied.

```ts
const template = new SandboxTemplate({ name: "worker", image: "node:22" });
await template.create({ labels: { role: "db" } });
await template.create({ labels: { role: "cache" } });

const dbs = await template.find({ label: { role: "db" } });
```

## Sandbox

```ts
class Sandbox {
  readonly id: string; // stays populated even after destroy(), for logging
  readonly name: string;
  readonly provider: SandboxProvider;

  // Lifecycle
  start(): Promise<void>;
  stop(opts?: { timeout?: number }): Promise<void>;
  restart(opts?: { timeout?: number }): Promise<void>;
  remove(opts?: { force?: boolean }): Promise<void>;
  destroy(): Promise<void>; // stop + remove, idempotent

  // Introspection
  inspect(): Promise<ContainerInfo>;
  isRunning(): Promise<boolean>;
  ip(): Promise<string | null>; // null when no IP (e.g. network: "none")
  address(port: number): Promise<{ host: string; port: number }>;

  // Exec
  exec(cmd: string[], opts?: ExecOptions): Promise<ExecResult>;
  spawn(cmd: string[], opts?: SpawnOptions): ExecHandle;

  // Logs
  logs(opts?: LogsOptions): Promise<string>;
  logsStream(opts?: LogsOptions): ReadableStream<string>;

  // Files (docker / podman only — Apple throws code: "unsupported")
  copyTo(hostPath: string, containerPath: string): Promise<void>;
  copyFrom(containerPath: string, hostPath: string): Promise<void>;
}
```

After `destroy()` every method except the properties throws `SandboxError({ code: "destroyed" })`.

### Streaming `spawn`

`spawn()` returns an `ExecHandle` with web-standard streams. Use it for long-running processes, interactive sessions, or when you need to pipe large amounts of data.

```ts
const handle = sandbox.spawn(["sh", "-c", "for i in 1 2 3; do echo $i; sleep 1; done"]);

for await (const chunk of handle.stdout) {
  process.stdout.write(chunk);
}
const exitCode = await handle.exited;
```

Send stdin:

```ts
const handle = sandbox.spawn(["cat"]);
const writer = handle.stdin.getWriter();
await writer.write(new TextEncoder().encode("hello\n"));
await writer.close();
await handle.exited;
```

Kill:

```ts
const handle = sandbox.spawn(["sleep", "30"]);
await handle.kill("SIGTERM");
```

`spawn({ tty: true })` allocates a pseudo-TTY for the exec session. Supported on all three providers.

### File copy

```ts
await sandbox.copyTo("/host/dir", "/container/dir");
await sandbox.copyFrom("/container/dir/result.json", "/tmp/result.json");
```

Apple Containers does not currently expose a CLI for file copy — both methods throw `SandboxError({ code: "unsupported" })` there.

### Port mapping and address resolution

`address(port)` returns the host-side endpoint for a container port:

- **Apple Containers**: container IP + same port (direct network access).
- **Docker / Podman**: `127.0.0.1` + the mapped host port.

```ts
const template = new SandboxTemplate({
  name: "web",
  image: "nginx:latest",
  ports: [{ host: 0, container: 80 }], // host: 0 auto-assigns
});
const sandbox = await template.create();

const { host, port } = await sandbox.address(80);
const response = await fetch(`http://${host}:${port}/`);
```

## Errors

All errors extend `SandboxError` and carry a `code`:

| Code                   | Meaning                                                               | Common subclass          |
| ---------------------- | --------------------------------------------------------------------- | ------------------------ |
| `provider_unavailable` | No runtime found / daemon not running                                 | `ProviderNotFoundError`  |
| `not_found`            | Container not found by ID or name                                     | `ContainerNotFoundError` |
| `cli_failed`           | CLI command exited non-zero (carries `command`, `exitCode`, `stderr`) | `CliError`               |
| `destroyed`            | Called a method on a destroyed `Sandbox`                              | `SandboxError`           |
| `port_unmapped`        | `address()` / `resolveAddress()` couldn't resolve a port              | `SandboxError`           |
| `unsupported`          | Feature not available on this provider                                | `SandboxError`           |
| `invalid_spec`         | Spec failed Zod validation                                            | `SandboxError`           |

```ts
import { SandboxError, CliError } from "sandbox";

try {
  await sandbox.copyTo("/a", "/b");
} catch (error) {
  if (error instanceof SandboxError && error.code === "unsupported") {
    // Apple Containers — fall back to something else
  } else if (error instanceof CliError) {
    console.error(error.stderr);
  }
}
```

## Providers

| Provider | macOS                     | Linux  | Container reachability    | Notes                       |
| -------- | ------------------------- | ------ | ------------------------- | --------------------------- |
| `apple`  | macOS 26+ (Apple Silicon) | -      | Direct IP                 | No `copy` or `hostname` yet |
| `docker` | via Docker Desktop        | Native | `localhost` + mapped port | Full feature set            |
| `podman` | via Podman Machine        | Native | `localhost` + mapped port | Full feature set            |

```ts
import { detectProviders, detectPreferredProvider, createProvider } from "sandbox";

detectProviders(); // ["apple", "docker"]
detectPreferredProvider(); // "apple" | null
const provider = createProvider("docker");
```

Providers can be used directly if you need to bypass `Sandbox`/`SandboxTemplate`, but prefer the high-level API unless you have a reason not to.

## Sandbox image

A reference agent-friendly image is built in `images/` via `docker buildx bake`. The SDK doesn't require it — any OCI image works — but it's what loxel ships and tests against.

```bash
cd images
docker buildx bake sandbox --set '*.platform=linux/<arch>' --load
# image tag: ghcr.io/bizimind/loxel/sandbox:latest
```

### Baked tools (version-pinned via `docker-bake.hcl`)

Each tool is fetched with an SHA256 checksum and composed into the final image as `/usr/local/bin/<tool>`:

| Category            | Tools                                                                                  |
| ------------------- | -------------------------------------------------------------------------------------- |
| Code search / files | `rg` (ripgrep), `fd`, `bat`, `fzf`, `jq`, `tree`                                       |
| Languages           | `python3` + `pip` (python-build-standalone), `go`, `node` + `npm`, `pnpm`, `bun`, `uv` |
| Cloud / infra       | `aws` (aws-cli), `terraform`, `kubectl`, `helm`                                        |
| Source / CI         | `git` (baked), `gh`                                                                    |
| Env / workflow      | `direnv`                                                                               |
| Agents              | `claude`, `codex`                                                                      |

### Apt-installed utilities

Stable OS utilities with no agent-level version sensitivity: `perl`, `less`, `libcurl3-gnutls`, `wget`, `unzip`, `make`, `gcc`, `g++`, `zsh`, `openssh-client`, `gnupg`.

### Shell

Bash is the default `CMD`. Zsh + Oh My Zsh (theme `robbyrussell`, plugins `(git fzf)`) is installed system-wide at `/opt/oh-my-zsh` and opt-in via `zsh -l`. Oh My Zsh is pinned to a specific upstream commit for reproducibility.

### Environment variables

| Variable           | Value                                 | Why                                                                             |
| ------------------ | ------------------------------------- | ------------------------------------------------------------------------------- |
| `PATH`             | `/usr/local/bin:/usr/local/go/bin:…`  | Exposes baked binaries and Go toolchain.                                        |
| `ZSH`              | `/opt/oh-my-zsh`                      | Oh My Zsh framework root.                                                       |
| `GIT_EXEC_PATH`    | `/usr/local/lib/git-core`             | The baked git layout lives under `/usr/local`; without this, HTTPS clones fail. |
| `GIT_TEMPLATE_DIR` | `/usr/local/share/git-core/templates` | Same rationale — `git init` picks up the correct default templates.             |

### Updating versions

Bump the relevant `<TOOL>_VERSION` and `<TOOL>_SHA256_{AMD64,ARM64}` variables at the top of `docker-bake.hcl`. Checksums are taken from upstream release artifacts (preferred) or computed directly when no checksum file is published.
