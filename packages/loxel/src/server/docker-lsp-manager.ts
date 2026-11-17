import path from "node:path";

import { WorktreeLspManager } from "./stdio-lsp-manager";

/**
 * Manages dockerfile-language-server-nodejs for Dockerfiles, compiled into `docker-langserver` by
 * scripts/build-dockerfile-lsp.ts. One subprocess per worktree, like the other lazily started
 * servers.
 *
 * Everything it does is local: its diagnostics are dockerfile-utils' checks of the file's text, and
 * the build replaces the registry client that image tag completion would use to ask Docker Hub.
 * Monaco's client does not pull configuration, so it validates and formats with its defaults.
 */
export class DockerLspManager extends WorktreeLspManager {
  // Shiki's Dockerfile grammar colors the file; the server's tokens would recolor it on top.
  protected override readonly disableSemanticTokens = true;

  constructor() {
    super("docker-lsp");
  }

  protected resolveBinary(): string | null {
    // Loxel's build only, also in development: the npm package's own `docker-langserver`, whether
    // in node_modules or installed on the PATH, still has the registry client the build replaces.
    return this.resolveBundledBinary(
      "docker-langserver",
      path.resolve(import.meta.dir, "../../build/docker-langserver"),
      false,
    );
  }

  protected override spawnArgs(): readonly string[] {
    return ["--stdio"];
  }
}
