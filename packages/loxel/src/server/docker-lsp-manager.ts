import path from "node:path";

import {
  type SpawnOptions,
  type SuppressibleFeature,
  WorktreeLspManager,
  type WtLspContext,
  type WtLspSession,
} from "./stdio-lsp-manager";

/**
 * The answer to the server's `docker.lsp` configuration pulls. Scout sends `FROM` image references
 * to Docker, and the server's defaults (used when it gets no answer) turn it on. `vulnerabilites` is
 * the server's spelling.
 */
const DOCKER_LSP_SETTINGS = {
  telemetry: "off",
  experimental: {
    vulnerabilityScanning: false,
    scout: {
      criticalHighVulnerabilities: false,
      notPinnedDigest: false,
      recommendedTag: false,
      vulnerabilites: false,
    },
  },
};

/**
 * Sends the server's HTTP clients to a closed loopback port. Nothing should reach it: this is the
 * failsafe for the moment before a document's configuration pull is answered, when the server's
 * defaults still have Scout on. Go reads `no_proxy` when `NO_PROXY` is empty, so both are cleared.
 * The server's `docker buildx` child inherits this, which only matters for a Docker daemon reached
 * over non-loopback TCP: its lint diagnostics stop. A local socket or `ssh://` is unaffected.
 */
const NO_OUTBOUND_HTTP_ENV = {
  HTTP_PROXY: "http://127.0.0.1:9",
  HTTPS_PROXY: "http://127.0.0.1:9",
  NO_PROXY: "",
  no_proxy: "",
};

/**
 * Manages Docker's official `docker-language-server` binary (Dockerfile +
 * docker-bake HCL). One subprocess per worktree, matching the ts-lsp
 * model — each `/ws/docker-lsp?wt=<path>` connection gets its own
 * subprocess rooted at the worktree path so bake files resolve relative
 * `dockerfile = "./..."` references correctly.
 *
 * The server itself sends nothing off the machine: scripts/build-docker-lsp.ts builds the binary
 * without Docker's telemetry and BugSnag keys, the settings above turn Scout off, and inlay hints
 * are suppressed because the server fetches their tag dates from Docker Hub, with no setting to
 * stop it. Its Dockerfile lint runs the user's own `docker buildx`, whose network use is theirs.
 *
 * Compose support is disabled at init time so our YAML LSP stays
 * authoritative for compose files. `removeOverlappingIssues` stays off: it
 * drops all error-level diagnostics, on the assumption that a second
 * Dockerfile server reports them, and Loxel has none. Full-text sync is
 * forced because docker-language-server overwrites its entire document with
 * each incremental fragment's replacement text (text_document_sync.go:33).
 * Semantic tokens are disabled because its token ranges routinely exceed
 * line length and Monaco rejects them.
 */
export class DockerLspManager extends WorktreeLspManager {
  protected override readonly disableSemanticTokens = true;
  protected override readonly requiresFullTextSync = true;
  protected override readonly suppressedFeatures: readonly SuppressibleFeature[] = [
    "textDocument/inlayHint",
  ];

  constructor() {
    super("docker-lsp");
  }

  protected resolveBinary(): string | null {
    const name =
      process.platform === "win32" ? "docker-language-server.exe" : "docker-language-server";
    return this.resolveBundledBinary(name, path.resolve(import.meta.dir, "../../build/", name));
  }

  protected override spawnArgs(): readonly string[] {
    return ["start", "--stdio"];
  }

  protected override spawnOptions(context: WtLspContext): SpawnOptions {
    return { ...super.spawnOptions(context), env: NO_OUTBOUND_HTTP_ENV };
  }

  protected override handleServerFrame(session: WtLspSession, body: string): void {
    try {
      const parsed: unknown = JSON.parse(body);
      if (typeof parsed === "object" && parsed !== null) {
        const msg = parsed as { id?: number | string; error?: { code?: number; message?: string } };
        // docker-language-server panics on some bake HCL positions (the
        // ConvertToHCLPosition index-out-of-range bug) and returns code
        // -32803 "Internal server error". Swallow *only* this known panic so
        // legitimate errors still surface to the client.
        if (
          msg.id !== undefined &&
          msg.error?.code === -32803 &&
          msg.error.message === "Internal server error"
        ) {
          this.log.warn(`Swallowing docker-lsp panic for request ${msg.id}`, { error: msg.error });
          session.ws.send(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: null }));
          return;
        }
      }
    } catch {
      // Not JSON — fall through.
    }
    super.handleServerFrame(session, body);
  }

  protected override getInitializationOptions(): Record<string, unknown> {
    return { dockercomposeExperimental: { composeSupport: false }, telemetry: "off" };
  }

  protected override async workspaceConfiguration(
    _session: WtLspSession,
    section: string | undefined,
  ): Promise<unknown> {
    return section === "docker.lsp" ? DOCKER_LSP_SETTINGS : null;
  }
}
