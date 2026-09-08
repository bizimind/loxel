/**
 * Interactive prompts.
 *
 * @inquirer/prompts is wrapped so output goes to stderr when stdout is piped:
 * that keeps `wt add -j | jq` working — the prompt is visible, and only the
 * result JSON is piped.
 */
import {
  confirm as inquirerConfirm,
  input as inquirerInput,
  search as inquirerSearch,
  select as inquirerSelect,
} from "@inquirer/prompts";

function promptConfig() {
  return process.stdout.isTTY === true ? {} : { output: process.stderr };
}

export const select: typeof inquirerSelect = (config, context) =>
  inquirerSelect(config, { ...promptConfig(), ...context });

export const confirm: typeof inquirerConfirm = (config, context) =>
  inquirerConfirm(config, { ...promptConfig(), ...context });

export const search: typeof inquirerSearch = (config, context) =>
  inquirerSearch(config, { ...promptConfig(), ...context });

export const input: typeof inquirerInput = (config, context) =>
  inquirerInput(config, { ...promptConfig(), ...context });

/** Whether stdin is a terminal, i.e. whether prompting is possible. */
export function isTTY(): boolean {
  return process.stdin.isTTY === true;
}

/** Ask for a worktree name. */
export function inputWorktreeName(): Promise<string> {
  return input({
    message: "Worktree name:",
    validate: (value) => (value.trim() ? true : "Worktree name is required"),
  });
}

/** Ask for the new name when renaming a worktree. */
export function inputNewWorktreeName(oldName: string): Promise<string> {
  return input({
    message: `New name for '${oldName}':`,
    default: oldName,
    validate: (value) => (value.trim() ? true : "Worktree name is required"),
  });
}

/** Confirm a rename that was started with no arguments at all. */
export function confirmRename(oldName: string, newName: string): Promise<boolean> {
  return confirm({ message: `Rename '${oldName}' to '${newName}'?`, default: true });
}

export type BranchExistsAction = "use-existing" | "delete-and-create" | "cancel";

/** Ask what to do when the branch a new worktree would create already exists. */
export function selectBranchExistsAction(branch: string): Promise<BranchExistsAction> {
  return select({
    message: `Branch '${branch}' already exists. What would you like to do?`,
    choices: [
      { name: `Use existing branch '${branch}'`, value: "use-existing" as const },
      {
        name: "Delete branch and create fresh (may lose unmerged commits)",
        value: "delete-and-create" as const,
      },
      { name: "Cancel", value: "cancel" as const },
    ],
  });
}

export type RemoveAction = "remove-with-branch" | "remove-only" | "cancel";

/** Ask whether to remove a worktree, and whether to take its branch with it. */
export function selectRemoveAction(name: string, branch: string | null): Promise<RemoveAction> {
  const choices: Array<{ name: string; value: RemoveAction }> = [];
  if (branch) {
    choices.push({
      name: `Remove worktree and delete local branch '${branch}'`,
      value: "remove-with-branch",
    });
  }
  choices.push(
    { name: "Remove worktree only (keep branch)", value: "remove-only" },
    { name: "Cancel", value: "cancel" },
  );

  return select({ message: `Remove worktree '${name}'?`, choices });
}

/** Confirm removing a worktree that has uncommitted or untracked changes. */
export function confirmForceRemove(name: string): Promise<boolean> {
  return confirm({
    message: `Worktree '${name}' has uncommitted or untracked changes. Remove it anyway?`,
    default: false,
  });
}

/** Type-to-filter picker over worktree names. */
export function pickWorktree(
  message: string,
  choices: Array<{ name: string; value: string }>,
): Promise<string> {
  return search({
    message,
    source: (term) => {
      if (!term) return choices;
      const lower = term.toLowerCase();
      return choices.filter((choice) => choice.name.toLowerCase().includes(lower));
    },
  });
}
