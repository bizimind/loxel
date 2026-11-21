const COMMIT_HASH_PATTERN = /^[a-f0-9]{4,40}$/i;
const REF_NAME_PATTERN = /^[a-zA-Z0-9_\-/.@,]+$/;
// oxlint-disable-next-line no-control-regex -- intentional: reject null bytes in paths
const SAFE_PATH_PATTERN = /^(?!.*(?:^|[/\\])\.\.(?:[/\\]|$))[^<>:"|?*\0]+$/;

export function validateCommitHash(hash: string): void {
  if (!COMMIT_HASH_PATTERN.test(hash)) {
    throw new Error(`Invalid commit hash: ${hash}`);
  }
}

/** A ref name that never starts with `-`, as git requires of branch names. */
export function validateRefName(ref: string): void {
  if (!REF_NAME_PATTERN.test(ref) || ref.startsWith("-")) {
    throw new Error(`Invalid ref name: ${ref}`);
  }
}

/** A relative path inside the repository. Git calls pass it after `--` or as `<rev>:<path>`. */
export function validatePath(path: string): void {
  if (!SAFE_PATH_PATTERN.test(path) || path.includes("..") || path.startsWith("/")) {
    throw new Error(`Invalid path: ${path}`);
  }
}
