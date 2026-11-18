/**
 * On macOS, release binaries are signed with Bizimind's Developer ID, and an update is installed
 * only when the downloaded binary carries that signature, as Squirrel.Mac does for the Loxel app.
 * Kept free of dependencies so the release workflow can run it without installing any.
 */

/** Bizimind's Apple Developer team, the subject OU of its Developer ID certificate. */
const TEAM_ID = "JJ88G244AR";

/** Absolute, so a `codesign` earlier on PATH cannot answer for the system one. */
export const CODESIGN = "/usr/bin/codesign";

/** The code signing identifier a release binary of `packageName` is signed with. */
export function codeSigningIdentifier(packageName: string): string {
  return `com.bizimind.${packageName}`;
}

/**
 * The code requirement a release binary of `packageName` satisfies: a Developer ID Application
 * certificate (the two Apple OIDs) issued to Bizimind's team, and the package's identifier, so
 * one CLI's binary cannot stand in for another's.
 */
export function releaseCodeRequirement(packageName: string): string {
  return [
    "anchor apple generic",
    "certificate 1[field.1.2.840.113635.100.6.2.6] exists",
    "certificate leaf[field.1.2.840.113635.100.6.1.13] exists",
    `certificate leaf[subject.OU] = "${TEAM_ID}"`,
    `identifier "${codeSigningIdentifier(packageName)}"`,
  ].join(" and ");
}

/** Throws unless the binary at `path` is a release binary of `packageName`, signed and intact. */
export async function verifyCodeSignature(path: string, packageName: string): Promise<void> {
  const proc = Bun.spawn(
    [CODESIGN, "--verify", "--strict", "-R", `=${releaseCodeRequirement(packageName)}`, path],
    { stdout: "ignore", stderr: "pipe" },
  );
  const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  if (exitCode === 0) return;
  // codesign's own reason (not signed, modified, another identity, unreadable) follows.
  throw new Error(
    `Refusing to install: the downloaded ${packageName} failed the release code signature check (Developer ID ${TEAM_ID}): ${stderr.trim()}`,
  );
}
