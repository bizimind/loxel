import { basename, join } from "node:path";

import { createResult, runAction, type OutputContext } from "@bizimind/cli-common";

import { GlobalStateManager } from "../global/state.ts";
import { writeWtYaml, type InitConfig } from "../init/config.ts";
import {
  detectRepoType,
  getBareRepoRoot,
  detectEditors,
  detectGhCli,
  isGhAuthenticated,
  getDefaultBranch,
  getCurrentBranch,
  hasUncommittedChanges,
  wtConfigExists,
  isTTY,
} from "../init/detect.ts";
import { setupGitHubRemote } from "../init/github.ts";
import {
  selectEditor,
  inputBaseBranch,
  selectGitHubOption,
  inputRepoName,
  confirmWorktreeInit,
  confirmBareRepoCreation,
  confirmBareRepoInit,
  confirmRegularToBareConversion,
} from "../init/prompts.ts";
import { initBareRepo, transformToBare, ensureWorktreesDir } from "../init/transform.ts";
import type { AbortedResult, InitResult } from "../types.ts";

export interface InitOptions {
  editor?: string;
  baseBranch?: string;
  github?: boolean;
  repoName?: string;
  public?: boolean;
  yes?: boolean;
  json?: boolean;
}

const WORKTREES_DIR = ".worktrees";

type InitCommandResult = InitResult | AbortedResult;

/**
 * Main init command implementation.
 */
export async function initCommand(options: InitOptions): Promise<void> {
  await runAction<InitCommandResult>(options, async (ctx) => {
    const cwd = process.cwd();
    const interactive = isTTY();

    // Detect repository type
    ctx.log("Detecting repository type...");
    let repoType = await detectRepoType(cwd);
    let workingDir = cwd;

    // Handle worktree case
    if (repoType === "worktree") {
      const bareRoot = await getBareRepoRoot(cwd);
      if (!bareRoot) {
        throw new Error("Detected worktree but could not find bare repository root.");
      }

      if (!interactive) {
        throw new Error(
          `Cannot init inside a worktree in non-interactive mode.\nRun from bare repo root: ${bareRoot}`,
        );
      }

      const proceed = await confirmWorktreeInit(bareRoot);
      if (!proceed) {
        return createResult<AbortedResult>(
          { aborted: true, reason: "User declined worktree init confirmation" },
          () => "Aborted.",
        );
      }

      // Now we're working with the bare repo
      workingDir = bareRoot;
      repoType = "bare";
    }

    // Check if wt.yaml already exists
    if (await wtConfigExists(workingDir)) {
      throw new Error("wt.yaml already exists. Use 'wt doctor' to repair or delete manually.");
    }

    // Route to appropriate handler based on repo type
    let result: InitResult | null = null;
    switch (repoType) {
      case "empty":
        result = await handleEmptyDir(ctx, workingDir, options, interactive);
        break;
      case "bare":
        result = await handleBareRepo(ctx, workingDir, options, interactive);
        break;
      case "regular":
        result = await handleRegularRepo(ctx, workingDir, options, interactive);
        break;
      default: {
        const _exhaustive: never = repoType;
        throw new Error(`Unknown repo type: ${String(_exhaustive)}`);
      }
    }

    // Register repo in global state on successful init
    if (result) {
      new GlobalStateManager().register(result.rootDir).catch(() => {});
      return createResult<InitResult>(result, formatInitResult);
    }

    return createResult<AbortedResult>(
      { aborted: true, reason: "User declined confirmation" },
      () => "Aborted.",
    );
  });
}

function formatInitResult(result: InitResult): string {
  const lines: string[] = [];

  if (result.converted) {
    lines.push(`\n✓ Converted to bare repository and initialized wt`);
    lines.push(`  Working tree moved to: ${WORKTREES_DIR}/${result.baseBranch}/`);
  } else {
    lines.push(`\n✓ Initialized wt in ${result.rootDir}`);
  }
  lines.push(`\nRun 'wt add <name>' to create your first worktree.`);

  return lines.join("\n");
}

/**
 * Handle init in an empty directory.
 */
async function handleEmptyDir(
  ctx: OutputContext,
  cwd: string,
  options: InitOptions,
  interactive: boolean,
): Promise<InitResult | null> {
  ctx.log("\n○ Empty directory");

  // Confirm creating bare repo
  if (interactive && !options.yes) {
    const proceed = await confirmBareRepoCreation();
    if (!proceed) {
      ctx.log("Aborted.");
      return null;
    }
  }

  // Gather configuration
  const config = await gatherConfig(cwd, options, interactive, true);

  // Check for GitHub integration
  let githubUrl: string | undefined;
  if (options.github || (interactive && !options.yes)) {
    const ghResult = await handleGitHubSetup(cwd, options, interactive);
    githubUrl = ghResult.url;

    // If user wants GitHub, we need a repo name
    if (ghResult.createRepo && !ghResult.repoName) {
      throw new Error("Repository name is required for GitHub setup.");
    }

    if (ghResult.createRepo && ghResult.repoName) {
      ctx.log("\nCreating GitHub repository...");
      githubUrl = await setupGitHubRemote(cwd, ghResult.repoName, ghResult.isPublic);
      ctx.log(`  Created: ${githubUrl}`);
    }
  }

  // Create bare repo
  ctx.log("\nCreating bare repository...");
  await initBareRepo(cwd, config.baseBranch);
  ctx.log("  Done");

  // Create wt.yaml
  ctx.log("Creating wt.yaml...");
  await writeWtYaml(cwd, config);
  ctx.log("  Done");

  // Create worktrees directory
  await ensureWorktreesDir(cwd, WORKTREES_DIR);

  ctx.log(`\n✓ Initialized wt in ${cwd}`);
  ctx.log(`\nRun 'wt add <name>' to create your first worktree.`);

  return {
    rootDir: cwd,
    configPath: join(cwd, "wt.yaml"),
    editor: config.editor ?? null,
    baseBranch: config.baseBranch,
    worktreesDir: join(cwd, WORKTREES_DIR),
    converted: false,
    githubUrl: githubUrl ?? null,
  };
}

/**
 * Handle init in an existing bare repository.
 */
async function handleBareRepo(
  ctx: OutputContext,
  cwd: string,
  options: InitOptions,
  interactive: boolean,
): Promise<InitResult | null> {
  ctx.log("\n○ Bare git repository");

  // Confirm init
  if (interactive && !options.yes) {
    const proceed = await confirmBareRepoInit();
    if (!proceed) {
      ctx.log("Aborted.");
      return null;
    }
  }

  // Gather configuration
  const config = await gatherConfig(cwd, options, interactive, false);

  // Create wt.yaml
  ctx.log("\nCreating wt.yaml...");
  await writeWtYaml(cwd, config);
  ctx.log("  Done");

  // Create worktrees directory
  await ensureWorktreesDir(cwd, WORKTREES_DIR);

  ctx.log(`\n✓ Initialized wt in ${cwd}`);
  ctx.log(`\nRun 'wt add <name>' to create your first worktree.`);

  return {
    rootDir: cwd,
    configPath: join(cwd, "wt.yaml"),
    editor: config.editor ?? null,
    baseBranch: config.baseBranch,
    worktreesDir: join(cwd, WORKTREES_DIR),
    converted: false,
    githubUrl: null,
  };
}

/**
 * Handle init in a regular git repository (convert to bare).
 */
async function handleRegularRepo(
  ctx: OutputContext,
  cwd: string,
  options: InitOptions,
  interactive: boolean,
): Promise<InitResult | null> {
  ctx.log("\n○ Regular git repository");

  // Check for uncommitted changes
  if (await hasUncommittedChanges(cwd)) {
    throw new Error(
      "Uncommitted changes detected. Commit or stash before converting to bare repo.",
    );
  }

  const currentBranch = await getCurrentBranch(cwd);

  // Confirm conversion
  if (interactive && !options.yes) {
    const proceed = await confirmRegularToBareConversion(currentBranch);
    if (!proceed) {
      ctx.log("Aborted.");
      return null;
    }
  }

  // Gather configuration
  const config = await gatherConfig(cwd, options, interactive, false);

  // Transform to bare
  ctx.log("\nConverting to bare repository...");
  await transformToBare(cwd, currentBranch, WORKTREES_DIR);
  ctx.log("  Done");

  // Create wt.yaml
  ctx.log("Creating wt.yaml...");
  await writeWtYaml(cwd, config);
  ctx.log("  Done");

  ctx.log(`\n✓ Converted to bare repository and initialized wt`);
  ctx.log(`  Working tree moved to: ${WORKTREES_DIR}/${currentBranch}/`);
  ctx.log(`\nRun 'wt add <name>' to create additional worktrees.`);

  return {
    rootDir: cwd,
    configPath: join(cwd, "wt.yaml"),
    editor: config.editor ?? null,
    baseBranch: config.baseBranch,
    worktreesDir: join(cwd, WORKTREES_DIR),
    converted: true,
    githubUrl: null,
  };
}

/**
 * Gather configuration from options or prompts.
 */
async function gatherConfig(
  cwd: string,
  options: InitOptions,
  interactive: boolean,
  isNewRepo: boolean,
): Promise<InitConfig> {
  let editor: string | undefined = options.editor;
  let baseBranch: string = options.baseBranch ?? (await getDefaultBranch(cwd));

  // Get editor
  if (!editor && interactive) {
    const detectedEditors = await detectEditors();

    if (options.yes) {
      // Auto-select first detected editor if --yes
      editor = detectedEditors[0]?.cmd;
    } else {
      const selectedEditor = await selectEditor(detectedEditors);
      editor = selectedEditor ?? undefined;
    }
  }

  // Get base branch (only prompt if interactive and not --yes)
  if (interactive && !options.yes && isNewRepo) {
    baseBranch = await inputBaseBranch(baseBranch);
  }

  return { editor, baseBranch, worktreesDir: WORKTREES_DIR };
}

interface GitHubSetupResult {
  createRepo: boolean;
  repoName?: string;
  isPublic: boolean;
  url?: string;
}

/**
 * Handle GitHub repository setup prompts/options.
 */
async function handleGitHubSetup(
  cwd: string,
  options: InitOptions,
  interactive: boolean,
): Promise<GitHubSetupResult> {
  // If --github flag not provided and not interactive, skip
  if (!options.github && !interactive) {
    return { createRepo: false, isPublic: false };
  }

  // If --github provided, validate requirements
  if (options.github) {
    if (!options.repoName) {
      throw new Error("--repo-name is required when using --github.");
    }

    const hasGh = await detectGhCli();
    if (!hasGh) {
      throw new Error("GitHub CLI (gh) not found. Install from https://cli.github.com");
    }

    const authenticated = await isGhAuthenticated();
    if (!authenticated) {
      throw new Error("GitHub CLI not authenticated. Run 'gh auth login' first.");
    }

    return { createRepo: true, repoName: options.repoName, isPublic: options.public ?? false };
  }

  // Interactive mode - check if gh is available
  const hasGh = await detectGhCli();
  if (!hasGh) {
    return { createRepo: false, isPublic: false };
  }

  const authenticated = await isGhAuthenticated();
  if (!authenticated) {
    return { createRepo: false, isPublic: false };
  }

  // Prompt for GitHub setup
  const githubOption = await selectGitHubOption();
  if (githubOption === "none") {
    return { createRepo: false, isPublic: false };
  }

  const defaultName = basename(cwd);
  const repoName = await inputRepoName(defaultName);

  return { createRepo: true, repoName, isPublic: githubOption === "public" };
}
