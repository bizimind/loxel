import type { ServerWebSocket, Subprocess } from "bun";

import path from "node:path";

import { type BaseLspSession, type SpawnOptions, StdioLspManager } from "./stdio-lsp-manager";

interface TerraformLspContext {
  wtPath: string;
}

interface TerraformLspSession extends BaseLspSession {
  wtPath: string;
}

/**
 * Manages HashiCorp's `terraform-ls` child processes, one per worktree.
 * Each `/ws/terraform-lsp?wt=<path>` connection gets its own subprocess
 * rooted at the worktree path so cross-file references (modules, variable
 * defs) resolve against the full worktree workspace.
 *
 * terraform-ls is a native Go binary bundled as `build/terraform-ls/`
 * and shipped with loxel-server via electron-builder extraResources.
 */
export class TerraformLspManager extends StdioLspManager<TerraformLspSession, TerraformLspContext> {
  protected override readonly disableSemanticTokens = true;

  constructor() {
    super("terraform-lsp");
  }

  createSession(ws: ServerWebSocket<unknown>, wtPath: string): void {
    this.startSession(ws, { wtPath });
  }

  destroySession(ws: ServerWebSocket<unknown>): void {
    this.detach(ws);
  }

  protected resolveBinary(): string | null {
    const sibling = path.join(path.dirname(process.execPath), "terraform-ls");
    if (Bun.file(sibling).size) return sibling;

    const dev = path.resolve(import.meta.dir, "../../build/terraform-ls/terraform-ls");
    if (Bun.file(dev).size) return dev;

    return Bun.which("terraform-ls");
  }

  protected override spawnArgs(): readonly string[] {
    // terraform-ls uses `serve`, not `--stdio`.
    return ["serve"];
  }

  protected override spawnOptions(context: TerraformLspContext): SpawnOptions {
    return { cwd: context.wtPath };
  }

  protected buildSession(
    ws: ServerWebSocket<unknown>,
    proc: Subprocess,
    context: TerraformLspContext,
  ): TerraformLspSession {
    return {
      ws,
      proc,
      wtPath: context.wtPath,
      stdoutBuf: Buffer.alloc(0),
      documentContents: new Map(),
    };
  }

  protected override getSessionWorkspace(session: TerraformLspSession): string | null {
    return session.wtPath;
  }

  protected override getInitializationOptions(): Record<string, unknown> {
    return {
      indexing: {
        ignoreDirectoryNames: [
          "node_modules",
          ".git",
          "dist",
          "build",
          ".turbo",
          ".next",
          ".cache",
          ".wt-local-res",
          ".worktrees",
          "coverage",
          "out",
        ],
      },
    };
  }
}
