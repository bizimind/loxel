import { chmodSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

import { reportRepoRestriction } from "./repo-trust";
import { buildSpawnEnv, type Env, NO_OUTBOUND_HTTP_ENV, pathWithoutCommand } from "./shell-env";
import { type SpawnOptions, WorktreeLspManager, type WtLspContext } from "./stdio-lsp-manager";

const TERRAFORM = "terraform";

/**
 * A version manager's `terraform` shim can install the version a project pins when it is missing
 * (tfenv, tenv, mise and aqua); these turn that off, since Loxel never fetches a toolchain.
 */
const NO_AUTO_INSTALL_ENV = {
  TFENV_AUTO_INSTALL: "false",
  TENV_AUTO_INSTALL: "false",
  MISE_AUTO_INSTALL: "0",
  MISE_NOT_FOUND_AUTO_INSTALL: "0",
  AQUA_DISABLE_LAZY_INSTALL: "true",
};

const TRUST_RESTRICTION =
  "Terraform doesn't run, so provider schemas come from terraform-ls's built-in set.";

/**
 * terraform-ls runs the `terraform` it finds on `PATH` for an initialized module, and reading
 * provider schemas that way starts the provider binaries under the module's `.terraform`. So in a
 * repository that isn't trusted, the server's `PATH` holds no `terraform`, and terraform-ls uses
 * its built-in schemas.
 *
 * terraform-ls also fetches the inputs and outputs of registry modules a file names from the
 * Terraform Registry, and searches the registry's modules while completing a module `source`, with
 * no setting to turn either off. Both go through its HTTP proxy, so it gets one that leads nowhere.
 * The `terraform` it runs inherits its environment, and reading provider schemas loads the
 * module's backend, which may be remote, so in a trusted repository terraform-ls finds a shim
 * first on its `PATH` that restores the user's proxy settings and `PATH` and runs their
 * `terraform`. Loxel ships no Windows build, which would need a shim of its own.
 */
export class TerraformLspManager extends WorktreeLspManager {
  protected override readonly disableSemanticTokens = true;
  protected override readonly repoTrustRestriction = TRUST_RESTRICTION;
  // Reported from `resolveBinary`, which knows whether there is a `terraform` to hold back.
  protected override readonly reportsRestrictionAtStart = false;

  constructor(private readonly shimDir: string) {
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
    const userEnv = buildSpawnEnv();
    const userPath = userEnv.PATH ?? "";
    if (!context.repoTrusted) {
      const PATH = pathWithoutCommand(userPath, TERRAFORM);
      return { ...options, env: { ...NO_OUTBOUND_HTTP_ENV, PATH } };
    }
    const env = { ...NO_OUTBOUND_HTTP_ENV, ...NO_AUTO_INSTALL_ENV };
    const terraform = Bun.which(TERRAFORM, { PATH: userPath });
    if (!terraform || process.platform === "win32") return { ...options, env };
    this.writeShim(terraform, userEnv);
    return { ...options, env: { ...env, PATH: `${this.shimDir}${path.delimiter}${userPath}` } };
  }

  /**
   * Writes the `terraform` that terraform-ls runs, replacing it whole so a running one is kept.
   * Only the user may read it, since a proxy URL can carry credentials.
   */
  private writeShim(terraform: string, userEnv: Env): void {
    mkdirSync(this.shimDir, { recursive: true, mode: 0o700 });
    chmodSync(this.shimDir, 0o700);
    const shim = path.join(this.shimDir, TERRAFORM);
    const tmp = `${shim}.${process.pid}.tmp`;
    writeFileSync(tmp, terraformShim(terraform, userEnv), { mode: 0o700 });
    chmodSync(tmp, 0o700);
    renameSync(tmp, shim);
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

/** POSIX shell quoting: the value in single quotes, each of its own as `'\''`. */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** A script that runs `terraform` with the user's `PATH` and proxy settings instead of the server's. */
function terraformShim(terraform: string, userEnv: Env): string {
  const restore = ["PATH", ...Object.keys(NO_OUTBOUND_HTTP_ENV)].map((name) => {
    const value = userEnv[name];
    return value === undefined ? `unset ${name}` : `export ${name}=${shellQuote(value)}`;
  });
  return ["#!/bin/sh", ...restore, `exec ${shellQuote(terraform)} "$@"`, ""].join("\n");
}
