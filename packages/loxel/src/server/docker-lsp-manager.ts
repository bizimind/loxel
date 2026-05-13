import type { ServerWebSocket, Subprocess } from "bun";

import path from "node:path";

import { type BaseLspSession, type SpawnOptions, StdioLspManager } from "./stdio-lsp-manager";

interface DockerLspContext {
  wtPath: string;
}

interface DockerLspSession extends BaseLspSession {
  wtPath: string;
}

/**
 * Manages Docker's official `docker-language-server` binary (Dockerfile +
 * docker-bake HCL). One subprocess per worktree, matching the ts-lsp
 * model — each `/ws/docker-lsp?wt=<path>` connection gets its own
 * subprocess rooted at the worktree path so bake files resolve relative
 * `dockerfile = "./..."` references correctly.
 *
 * Compose support is disabled at init time so our YAML LSP stays
 * authoritative for compose files. Full-text sync is forced because
 * docker-language-server overwrites its entire document with each
 * incremental fragment's replacement text (text_document_sync.go:33).
 * Semantic tokens are disabled because its token ranges routinely exceed
 * line length and Monaco rejects them.
 */
export class DockerLspManager extends StdioLspManager<DockerLspSession, DockerLspContext> {
  protected override readonly disableSemanticTokens = true;
  protected override readonly requiresFullTextSync = true;

  constructor() {
    super("docker-lsp");
  }

  createSession(ws: ServerWebSocket<unknown>, wtPath: string): void {
    this.startSession(ws, { wtPath });
  }

  destroySession(ws: ServerWebSocket<unknown>): void {
    this.detach(ws);
  }

  protected resolveBinary(): string | null {
    const name =
      process.platform === "win32" ? "docker-language-server.exe" : "docker-language-server";
    return this.resolveBundledBinary(name, path.resolve(import.meta.dir, "../../build/", name));
  }

  protected override spawnArgs(): readonly string[] {
    return ["start", "--stdio"];
  }

  protected override spawnOptions(context: DockerLspContext): SpawnOptions {
    return { cwd: context.wtPath };
  }

  protected buildSession(
    ws: ServerWebSocket<unknown>,
    proc: Subprocess,
    context: DockerLspContext,
  ): DockerLspSession {
    return {
      ws,
      proc,
      wtPath: context.wtPath,
      stdoutBuf: Buffer.alloc(0),
      documentContents: new Map(),
    };
  }

  protected override getSessionKey(context: DockerLspContext): string {
    return context.wtPath;
  }

  protected override getSessionWorkspace(session: DockerLspSession): string | null {
    return session.wtPath;
  }

  protected override handleServerFrame(session: DockerLspSession, body: string): void {
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

  protected override onClientInitialized(session: DockerLspSession): void {
    const msg = JSON.stringify({
      jsonrpc: "2.0",
      method: "workspace/didChangeConfiguration",
      params: {
        settings: {
          docker: { lsp: { experimental: { vulnerabilityScanning: false } } },
          dockerfileExperimental: { removeOverlappingIssues: true },
          dockercomposeExperimental: { composeSupport: false },
          telemetry: "off",
        },
      },
    });
    this.writeToStdin(session, msg);
  }
}
