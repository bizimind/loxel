import { wrapError } from "@bizimind/cli-common";
import { $ } from "bun";

/**
 * Create a GitHub repository using the gh CLI.
 *
 * @param name - Repository name
 * @param isPublic - Whether to create a public repo (default: private)
 * @param cwd - Directory to run command from
 * @returns The repository URL
 */
export async function createGitHubRepo(
  name: string,
  isPublic: boolean,
  cwd: string,
): Promise<string> {
  try {
    const visibility = isPublic ? "--public" : "--private";

    // Create the repo and get its URL
    const result =
      await $`gh repo create ${name} ${visibility} --source=${cwd} --remote=origin --push`.text();

    // Extract URL from output (gh outputs the URL)
    const urlMatch = result.match(/https:\/\/github\.com\/[^\s]+/);
    if (urlMatch) {
      return urlMatch[0];
    }

    // If no URL in output, construct it
    const username = await getGitHubUsername();
    return `https://github.com/${username}/${name}`;
  } catch (err) {
    throw wrapError("Failed to create GitHub repository", err);
  }
}

/**
 * Get the authenticated GitHub username.
 */
async function getGitHubUsername(): Promise<string> {
  try {
    const result = await $`gh api user --jq .login`.text();
    return result.trim();
  } catch {
    return "unknown";
  }
}

/**
 * Add a remote to a bare repository.
 */
export async function addRemote(cwd: string, name: string, url: string): Promise<void> {
  try {
    await $`git -C ${cwd} remote add ${name} ${url}`.quiet();
  } catch (err) {
    // Remote might already exist
    if (String(err).includes("already exists")) {
      await $`git -C ${cwd} remote set-url ${name} ${url}`.quiet();
    } else {
      throw wrapError(`Failed to add remote '${name}'`, err);
    }
  }
}

/**
 * Set up the remote for a bare repo that was just created.
 * This is simpler than using `gh repo create --source` on an empty repo.
 */
export async function setupGitHubRemote(
  cwd: string,
  repoName: string,
  isPublic: boolean,
): Promise<string> {
  try {
    const visibility = isPublic ? "--public" : "--private";

    // Create the repo on GitHub (without source, since it's empty/bare)
    await $`gh repo create ${repoName} ${visibility}`.quiet();

    // Get the URL
    const username = await getGitHubUsername();
    const url = `https://github.com/${username}/${repoName}.git`;

    // Add as remote
    await addRemote(cwd, "origin", url);

    return `https://github.com/${username}/${repoName}`;
  } catch (err) {
    throw wrapError("Failed to create GitHub repository", err);
  }
}
