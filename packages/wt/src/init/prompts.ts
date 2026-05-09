import { confirm, select, input } from "../prompt.ts";

export type BranchExistsAction = "use-existing" | "delete-and-create" | "cancel";

/**
 * Prompt user for action when branch already exists during wt add.
 */
export function selectBranchExistsAction(branchName: string): Promise<BranchExistsAction> {
  return select({
    message: `Branch '${branchName}' already exists. What would you like to do?`,
    choices: [
      { name: `Use existing branch '${branchName}'`, value: "use-existing" as const },
      {
        name: "Delete branch and create fresh (may lose unmerged commits)",
        value: "delete-and-create" as const,
      },
      { name: "Cancel", value: "cancel" as const },
    ],
  });
}

export type RemoveAction = "remove-with-branch" | "remove-only" | "cancel";

/**
 * Prompt user for worktree removal options.
 */
export function selectRemoveAction(
  worktreeName: string,
  branchName: string | null,
): Promise<RemoveAction> {
  const choices: Array<{ name: string; value: RemoveAction }> = [];
  if (branchName) {
    choices.push({
      name: `Remove worktree and delete local branch '${branchName}'`,
      value: "remove-with-branch",
    });
  }
  choices.push(
    { name: "Remove worktree only (keep branch)", value: "remove-only" },
    { name: "Cancel", value: "cancel" },
  );
  return select({ message: `Remove worktree '${worktreeName}'?`, choices });
}

/**
 * Confirm an action with the user.
 */
export function confirmAction(message: string, defaultValue = true): Promise<boolean> {
  return confirm({ message, default: defaultValue });
}

/**
 * Select an editor from detected editors.
 */
export async function selectEditor(
  detectedEditors: Array<{ cmd: string; name: string }>,
): Promise<string | null> {
  if (detectedEditors.length === 0) {
    // No editors detected, ask for custom input
    const useCustom = await confirm({
      message: "No common editors detected. Would you like to specify one?",
      default: false,
    });

    if (!useCustom) {
      return null;
    }

    return input({
      message: "Enter editor command:",
      validate: (value) => (value.trim() ? true : "Please enter a command"),
    });
  }

  const choices = [
    ...detectedEditors.map((e) => ({ name: `${e.cmd} (${e.name})`, value: e.cmd })),
    { name: "Other (enter command)", value: "__other__" },
    { name: "None (skip editor setup)", value: "__none__" },
  ];

  const selected = await select({ message: "Select your editor:", choices });

  if (selected === "__none__") {
    return null;
  }

  if (selected === "__other__") {
    return input({
      message: "Enter editor command:",
      validate: (value) => (value.trim() ? true : "Please enter a command"),
    });
  }

  return selected;
}

/**
 * Input base branch name.
 */
export function inputBaseBranch(defaultBranch: string): Promise<string> {
  return input({
    message: "Base branch name:",
    default: defaultBranch,
    validate: (value) => (value.trim() ? true : "Please enter a branch name"),
  });
}

export type GitHubOption = "private" | "public" | "none";

/**
 * Select GitHub repository creation option.
 */
export function selectGitHubOption(): Promise<GitHubOption> {
  return select({
    message: "GitHub CLI detected. Create a remote repository?",
    choices: [
      { name: "No, local only", value: "none" as const },
      { name: "Yes, create private repo", value: "private" as const },
      { name: "Yes, create public repo", value: "public" as const },
    ],
    default: "none",
  });
}

/**
 * Input repository name.
 */
export function inputRepoName(defaultName: string): Promise<string> {
  return input({
    message: "Repository name:",
    default: defaultName,
    validate: (value) => {
      const trimmed = value.trim();
      if (!trimmed) return "Please enter a repository name";
      // Basic validation for GitHub repo name
      if (!/^[a-zA-Z0-9._-]+$/.test(trimmed)) {
        return "Repository name can only contain letters, numbers, hyphens, underscores, and dots";
      }
      return true;
    },
  });
}

/**
 * Confirm worktree detection and offer to init at bare repo root.
 */
export function confirmWorktreeInit(bareRepoPath: string): Promise<boolean> {
  process.stderr.write(`\nYou are inside a worktree.\n`);
  process.stderr.write(`Bare repository root: ${bareRepoPath}\n`);

  return confirm({ message: "Initialize wt in the bare repository root?", default: true });
}

/**
 * Confirm bare repo creation in empty directory.
 */
export function confirmBareRepoCreation(): Promise<boolean> {
  process.stderr.write("\nNo git repository found in this directory.\n");

  return confirm({ message: "Create a new bare git repository here?", default: true });
}

/**
 * Confirm initialization in existing bare repo.
 */
export function confirmBareRepoInit(): Promise<boolean> {
  process.stderr.write("\nBare git repository detected.\n");

  return confirm({ message: "Initialize wt in this repository?", default: true });
}

/**
 * Confirm conversion from regular repo to bare.
 */
export function confirmRegularToBareConversion(currentBranch: string): Promise<boolean> {
  process.stderr.write("\nRegular git repository detected.\n");
  process.stderr.write("\n⚠ This will convert to a bare repository structure:\n");
  process.stderr.write(`  - Current working tree → .worktrees/${currentBranch}\n`);
  process.stderr.write("  - Repository data → bare repo root\n");

  return confirm({ message: "Proceed with conversion?", default: false });
}

/**
 * Input worktree name for wt add.
 */
export function inputWorktreeName(): Promise<string> {
  return input({
    message: "Worktree name:",
    validate: (value) => {
      if (!value.trim()) return "Worktree name is required";
      return true;
    },
  });
}

/**
 * Confirm force removal of a worktree with local changes.
 */
export function confirmForceRemove(worktreeName: string): Promise<boolean> {
  return confirm({
    message: `Force remove worktree '${worktreeName}' despite warnings above?`,
    default: false,
  });
}
