import {
  createUpdateCommand,
  createVersionCommand,
  maybeAutoUpdate,
  type UpdateConfig,
} from "@bizimind/cli-common";
import { program } from "commander";

import { getCurrentVersion } from "./version.ts";

program
  .name("wt")
  .description("Configless git worktree manager. Git is the database; hooks do the setup.")
  .version(getCurrentVersion());

program
  .command("list")
  .alias("ls")
  .description("List all worktrees")
  .option("-j, --json", "Output as JSON")
  .action(async (opts) => {
    const { listCommand } = await import("./commands/list.ts");
    await listCommand(opts);
  });

program
  .command("add [name]")
  .alias("create")
  .description("Create a worktree in .worktrees/ (or $WT_DIR) and run init.wt.sh")
  .option("-b, --branch <branch>", "Check out an existing branch instead of creating one")
  .option("-j, --json", "Output as JSON")
  .action(async (name, opts) => {
    const { addCommand } = await import("./commands/add.ts");
    await addCommand(name, opts);
  });

program
  .command("view [name]")
  .description("View detailed information about a worktree")
  .option("-j, --json", "Output as JSON")
  .action(async (name: string | undefined, opts: { json?: boolean }) => {
    const { viewCommand } = await import("./commands/view.ts");
    await viewCommand(name, opts);
  });

program
  .command("mv [names...]")
  .aliases(["rename", "move"])
  .description("Rename a worktree and its branch, then run rename.wt.sh")
  .option("--branch <branch>", "Rename the branch to this instead of the new worktree name")
  .option("-B, --keep-branch", "Rename the directory only, leaving the branch alone")
  .option("-f, --force", "Move a locked worktree")
  .option("-j, --json", "Output as JSON")
  .action(async (names: string[], opts) => {
    const { mvCommand } = await import("./commands/mv.ts");
    await mvCommand(names, opts);
  });

program
  .command("remove [name]")
  .aliases(["rm", "delete"])
  .description("Remove a worktree, running clean.wt.sh first")
  .option("-f, --force", "Remove even with uncommitted or untracked changes")
  .option("-d, --delete-branch", "Also delete the worktree's branch")
  .option("--keep-branch", "Keep the branch (no prompt)")
  .option("-j, --json", "Output as JSON")
  .action(async (name: string | undefined, opts) => {
    const { removeCommand } = await import("./commands/remove.ts");
    await removeCommand(name, opts);
  });

const updateConfig: UpdateConfig = { packageName: "wt", getCurrentVersion, cacheEnabled: true };

// Version and update commands use cli-common factories for consistent runAction pattern
program.addCommand(createVersionCommand(updateConfig));
program.addCommand(createUpdateCommand(updateConfig));

async function runWithAutoUpdate(): Promise<void> {
  // Auto-update is opt-in via WT_AUTO_UPDATE=1; `wt update` is always available.
  const isAutoUpdateEnabled = () => Promise.resolve(process.env.WT_AUTO_UPDATE === "1");

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
