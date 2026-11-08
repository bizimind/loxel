import path from "node:path";

import { WorktreeLspManager, type WtLspSession } from "./stdio-lsp-manager";

/** Exported for tests. */
export const ASTRO_REPO_TRUST_RESTRICTION =
  "The Astro language server doesn't run, since it loads the project's own TypeScript and packages.";

/**
 * astro-ls has no restricted mode: it requires a TypeScript to load by path, the project's own in
 * `node_modules`, and loads the project's Prettier and its Vue and Svelte editor integrations. So it
 * runs only in a trusted repository, and starts when the repository is trusted.
 */
export class AstroLspManager extends WorktreeLspManager {
  protected override readonly disableSemanticTokens = true;
  protected override readonly repoTrustRestriction = ASTRO_REPO_TRUST_RESTRICTION;
  protected override readonly runsOnlyWhenTrusted = true;

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
