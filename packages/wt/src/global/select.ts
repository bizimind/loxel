import { join } from "node:path";

import { isTTY } from "../init/detect.ts";
import { select } from "../prompt.ts";
import { GlobalStateManager } from "./state.ts";

const CONFIG_FILENAME = "wt.yaml";

/** Session-level cache for selected repo to avoid prompting multiple times per command */
let cachedSelectedRepo: string | null = null;

/**
 * Check if a repo path has a valid wt.yaml config file.
 */
async function isValidRepo(repoPath: string): Promise<boolean> {
  const configPath = join(repoPath, CONFIG_FILENAME);
  return Bun.file(configPath).exists();
}

/**
 * Filter repos to only those with valid wt.yaml files.
 */
async function getValidRepos(repoPaths: string[]): Promise<string[]> {
  const results = await Promise.all(
    repoPaths.map(async (path) => ({ path, valid: await isValidRepo(path) })),
  );
  return results.filter((r) => r.valid).map((r) => r.path);
}

/**
 * Format the non-interactive error message with known repos.
 */
function formatNonInteractiveError(validRepos: string[], globalState: GlobalStateManager): string {
  if (validRepos.length === 0) {
    return `No ${CONFIG_FILENAME} found in current directory or parents.

No known repositories. Run 'wt init' in a bare git repo to get started.`;
  }

  const repoList = validRepos
    .map((path) => `  ${globalState.getDisplayName(path, validRepos)}`)
    .join("\n");

  return `No ${CONFIG_FILENAME} found in current directory or parents.

Known repositories:
${repoList}

Hint: Run from within a wt-managed repo, or use --repo <name>.`;
}

/**
 * Prompt user to select a repository interactively.
 * Returns the selected repo path.
 *
 * @throws Error if no valid repos exist or in non-interactive mode
 */
export async function selectRepo(): Promise<string> {
  // Return cached selection if available (avoids prompting multiple times per command)
  if (cachedSelectedRepo !== null) {
    return cachedSelectedRepo;
  }

  const globalState = new GlobalStateManager();
  const allRepos = await globalState.getAll();
  const validRepos = await getValidRepos(allRepos);

  if (!isTTY()) {
    throw new Error(formatNonInteractiveError(validRepos, globalState));
  }

  if (validRepos.length === 0) {
    throw new Error(
      `No ${CONFIG_FILENAME} found in current directory or parents.\n\n` +
        `No known repositories. Run 'wt init' in a bare git repo to get started.`,
    );
  }

  const choices = validRepos.map((path) => ({
    name: globalState.getDisplayName(path, validRepos),
    value: path,
  }));

  const selectedPath = await select({
    message: `No ${CONFIG_FILENAME} found. Select a repository:`,
    choices,
  });

  // Cache for subsequent calls in this process
  cachedSelectedRepo = selectedPath;

  return selectedPath;
}

/**
 * Resolve a repo by name and return its path.
 *
 * @throws Error if repo not found or ambiguous
 */
export async function resolveRepoByName(name: string): Promise<string> {
  const globalState = new GlobalStateManager();
  const result = await globalState.resolveByName(name);

  switch (result.status) {
    case "found": {
      // Validate that the repo still has wt.yaml
      if (!(await isValidRepo(result.path))) {
        throw new Error(
          `Repository '${name}' found at ${result.path} but ${CONFIG_FILENAME} no longer exists.`,
        );
      }
      return result.path;
    }

    case "ambiguous": {
      const suggestions = result.paths.map((path) =>
        globalState.getDisplayName(path, result.paths),
      );
      throw new Error(
        `Ambiguous repository name '${name}'. Did you mean one of:\n  ${suggestions.join("\n  ")}`,
      );
    }

    case "not_found": {
      const allRepos = await globalState.getAll();
      if (allRepos.length === 0) {
        throw new Error(
          `Repository '${name}' not found. No known repositories.\n\n` +
            `Run 'wt init' in a bare git repo to get started.`,
        );
      }

      const validRepos = await getValidRepos(allRepos);
      const suggestions = validRepos.map((path) => globalState.getDisplayName(path, validRepos));
      throw new Error(
        `Repository '${name}' not found.\n\nKnown repositories:\n  ${suggestions.join("\n  ")}`,
      );
    }

    default: {
      const _exhaustive: never = result;
      throw new Error(`Unknown resolve status: ${String(_exhaustive)}`);
    }
  }
}
