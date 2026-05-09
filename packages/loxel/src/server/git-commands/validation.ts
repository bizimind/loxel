/** Enables git's built-in fsmonitor daemon for commands that scan the working tree or index. */
export const FSMONITOR = ["-c", "core.fsmonitor=true"];

const COMMIT_HASH_PATTERN = /^[a-f0-9]{4,40}$/i;
const REF_NAME_PATTERN = /^[a-zA-Z0-9_\-/.@]+$/;
// oxlint-disable-next-line no-control-regex -- intentional: reject null bytes in paths
const SAFE_PATH_PATTERN = /^(?!.*(?:^|[/\\])\.\.(?:[/\\]|$))[^<>:"|?*\0]+$/;

export function validateCommitHash(hash: string): void {
  if (!COMMIT_HASH_PATTERN.test(hash)) {
    throw new Error(`Invalid commit hash: ${hash}`);
  }
}

export function validateRefName(ref: string): void {
  if (!REF_NAME_PATTERN.test(ref)) {
    throw new Error(`Invalid ref name: ${ref}`);
  }
}

export function validatePath(path: string): void {
  if (!SAFE_PATH_PATTERN.test(path) || path.includes("..")) {
    throw new Error(`Invalid path: ${path}`);
  }
}
