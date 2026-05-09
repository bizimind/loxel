const BRANCH_COLORS: readonly string[] = [
  "var(--branch-1)",
  "var(--branch-2)",
  "var(--branch-3)",
  "var(--branch-4)",
  "var(--branch-5)",
  "var(--branch-6)",
];

const colorCache = new Map<string, string>();

function getColor(index: number): string {
  return BRANCH_COLORS[index % BRANCH_COLORS.length] ?? "var(--branch-1)";
}

/**
 * Get a consistent color for a branch name.
 * Uses a simple hash to assign colors deterministically.
 */
export function getBranchColor(branchName: string): string {
  const cached = colorCache.get(branchName);
  if (cached) return cached;

  // Simple hash based on branch name
  let hash = 0;
  for (let i = 0; i < branchName.length; i++) {
    hash = (hash << 5) - hash + branchName.charCodeAt(i);
    hash = hash & hash; // Convert to 32bit integer
  }

  const color = getColor(Math.abs(hash));
  colorCache.set(branchName, color);
  return color;
}

/**
 * Get a color for a lane index.
 */
export function getLaneColor(laneIndex: number): string {
  return getColor(laneIndex);
}
