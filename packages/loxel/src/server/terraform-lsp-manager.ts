import path from "node:path";

import { reportRepoRestriction } from "./repo-trust";
import { buildSpawnEnv, pathWithoutCommand } from "./shell-env";
import { type SpawnOptions, WorktreeLspManager, type WtLspContext } from "./stdio-lsp-manager";

const TERRAFORM = "terraform";

/**
 * A version manager's `terraform` shim installs the version a project pins when it is missing, by
 * default for tfenv and mise; these turn that off, since Loxel never fetches a toolchain.
 */
const NO_AUTO_INSTALL_ENV = {
  TFENV_AUTO_INSTALL: "false",
  TENV_AUTO_INSTALL: "false",
  MISE_NOT_FOUND_AUTO_INSTALL: "0",
};

const TRUST_RESTRICTION =
  "Terraform doesn't run, so provider schemas come from terraform-ls's built-in set.";

/**
 * terraform-ls runs the `terraform` it finds on `PATH` for an initialized module, and reading
 * provider schemas that way starts the provider binaries under the module's `.terraform`. So in a
 * repository that isn't trusted, the server's `PATH` holds no `terraform`, and terraform-ls uses
 * its built-in schemas.
 */
export class TerraformLspManager extends WorktreeLspManager {
  protected override readonly disableSemanticTokens = true;
  protected override readonly repoTrustRestriction = TRUST_RESTRICTION;
  // Reported from `resolveBinary`, which knows whether there is a `terraform` to hold back.
  protected override readonly reportsRestrictionAtStart = false;

  constructor() {
    super("terraform-lsp");
  }

  protected resolveBinary({ repoTrusted, wtPath }: WtLspContext): string | null {
    if (!repoTrusted && Bun.which(TERRAFORM, { PATH: buildSpawnEnv().PATH ?? "" })) {
      reportRepoRestriction(wtPath, TRUST_RESTRICTION);
    }
    return this.resolveBundledBinary(
      "terraform-ls",
      path.resolve(import.meta.dir, "../../build/terraform-ls"),
    );
  }

  protected override spawnArgs(): readonly string[] {
    // terraform-ls uses `serve`, not `--stdio`.
    return ["serve"];
  }

  protected override spawnOptions(context: WtLspContext): SpawnOptions {
    const options = super.spawnOptions(context);
    if (context.repoTrusted) return { ...options, env: NO_AUTO_INSTALL_ENV };
    return { ...options, env: { PATH: pathWithoutCommand(buildSpawnEnv().PATH ?? "", TERRAFORM) } };
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
