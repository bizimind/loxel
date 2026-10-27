import path from "node:path";

import { WorktreeLspManager, type WtLspSession } from "./stdio-lsp-manager";

export class AstroLspManager extends WorktreeLspManager {
  protected override readonly disableSemanticTokens = true;

  constructor() {
    super("astro-lsp");
  }

  protected resolveBinary(): string | null {
    return this.resolveBundledBinary("astro-ls");
  }

  protected override spawnArgs(): readonly string[] {
    return ["--stdio"];
  }

  protected override getInitializationOptions(session: WtLspSession): Record<string, unknown> {
    return {
      typescript: { tsdk: path.join(session.wtPath, "node_modules/typescript/lib") },
      contentIntellisense: true,
    };
  }
}
