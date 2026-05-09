import {
  createUpdateCommand,
  createVersionCommand,
  maybeAutoUpdate,
  type UpdateConfig,
} from "@bizimind/cli-common";
import { program } from "commander";

import { resolveRepoByName } from "./global/select.ts";
import { getCurrentVersion } from "./version.ts";

program
  .name("wt")
  .description("Manage git worktrees with port offsetting, unique naming, and hooks")
  .version(getCurrentVersion())
  .option("--repo <name>", "Specify repository by name (use parent/name for disambiguation)");

/**
 * Get the resolved repo path from the global --repo option, if provided.
 */
async function getRepoPath(): Promise<string | undefined> {
  const opts = program.opts();
  if (opts.repo) {
    return resolveRepoByName(opts.repo);
  }
  return undefined;
}

program
  .command("init")
  .description("Initialize a repository for wt worktree management")
  .option("--editor <cmd>", "Editor command (e.g., code, cursor, zed)")
  .option("--base-branch <branch>", "Base branch name (default: main)")
  .option("--github", "Create a GitHub repository (empty folder only)")
  .option("--repo-name <name>", "GitHub repository name (required with --github)")
  .option("--public", "Make GitHub repository public (default: private)")
  .option("-y, --yes", "Skip confirmation prompts")
  .option("-j, --json", "Output as JSON")
  .action(async (opts) => {
    const { initCommand } = await import("./commands/init.ts");
    await initCommand(opts);
  });

program
  .command("list")
  .alias("ls")
  .description("List all worktrees")
  .option("-j, --json", "Output as JSON")
  .action(async (opts) => {
    const repoPath = await getRepoPath();
    const { listCommand } = await import("./commands/list.ts");
    await listCommand({ ...opts, repoPath });
  });

program
  .command("add [name]")
  .alias("create")
  .description("Create a new worktree")
  .option("--open", "Open worktree in editor after creation")
  .option("--no-open", "Do not open worktree in editor")
  .option("-b, --branch <branch>", "Use existing branch instead of creating new one")
  .option("-j, --json", "Output as JSON")
  .action(async (name, opts) => {
    const repoPath = await getRepoPath();
    const { addCommand } = await import("./commands/add.ts");
    await addCommand(name, { ...opts, repoPath });
  });

program
  .command("open [name]")
  .description("Open an existing worktree in the configured editor")
  .option("-j, --json", "Output as JSON")
  .action(async (name?: string, opts?: { json?: boolean }) => {
    const repoPath = await getRepoPath();
    const { openCommand } = await import("./commands/open.ts");
    await openCommand(name, { ...opts, repoPath });
  });

program
  .command("view [name]")
  .description("View detailed information about a worktree")
  .option("-j, --json", "Output as JSON")
  .action(async (name?: string, opts?: { json?: boolean }) => {
    const repoPath = await getRepoPath();
    const { viewCommand } = await import("./commands/view.ts");
    await viewCommand(name, { ...opts, repoPath });
  });

program
  .command("remove [name]")
  .aliases(["rm", "delete"])
  .description("Remove a worktree (runs clean hook)")
  .option("-f, --force", "Force removal even with uncommitted changes")
  .option("-j, --json", "Output as JSON")
  .action(async (name: string | undefined, opts) => {
    const repoPath = await getRepoPath();
    const { removeCommand } = await import("./commands/remove.ts");
    await removeCommand(name, { ...opts, repoPath });
  });

const updateConfig: UpdateConfig = { packageName: "wt", getCurrentVersion, cacheEnabled: true };

// Version and update commands use cli-common factories for consistent runAction pattern
program.addCommand(createVersionCommand(updateConfig));
program.addCommand(createUpdateCommand(updateConfig));

async function runWithAutoUpdate(): Promise<void> {
  // Check if auto-update is enabled via config
  const isAutoUpdateEnabled = async () => {
    try {
      const { loadConfig } = await import("./config/loader.ts");
      const loaded = await loadConfig(process.cwd());
      return loaded?.config.automatic_updates ?? false;
    } catch {
      return false;
    }
  };

  const updated = await maybeAutoUpdate({ ...updateConfig, isAutoUpdateEnabled }, process.argv);

  if (updated) {
    // maybeAutoUpdate already re-executed and exited
    process.exit(0);
  }

  await program.parseAsync();
}

runWithAutoUpdate().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`Error: ${message}\n`);
  process.exit(1);
});
