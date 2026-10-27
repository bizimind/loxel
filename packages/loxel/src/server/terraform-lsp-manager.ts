import path from "node:path";

import { WorktreeLspManager } from "./stdio-lsp-manager";

export class TerraformLspManager extends WorktreeLspManager {
  protected override readonly disableSemanticTokens = true;

  constructor() {
    super("terraform-lsp");
  }

  protected resolveBinary(): string | null {
    return this.resolveBundledBinary(
      "terraform-ls",
      path.resolve(import.meta.dir, "../../build/terraform-ls"),
    );
  }

  protected override spawnArgs(): readonly string[] {
    // terraform-ls uses `serve`, not `--stdio`.
    return ["serve"];
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
