import * as fs from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

import { GlobalStateSchema, type GlobalState } from "./schema.ts";

const STATE_DIR = join(homedir(), ".local", "state", "loxel", "wt");
const STATE_FILE = join(STATE_DIR, "repos.json");

/**
 * Result of resolving a repo by name.
 */
export type ResolveResult =
  | { status: "found"; path: string }
  | { status: "ambiguous"; paths: string[] }
  | { status: "not_found" };

/**
 * Global state manager for tracking known wt-managed repositories.
 * Persists to ~/.local/state/loxel/wt/repos.json
 */
export class GlobalStateManager {
  private state: GlobalState | null = null;

  /**
   * Ensure the state directory exists.
   */
  private ensureDir(): void {
    if (!fs.existsSync(STATE_DIR)) {
      fs.mkdirSync(STATE_DIR, { recursive: true });
    }
  }

  /**
   * Load state from disk. Creates empty state if file doesn't exist.
   */
  private async load(): Promise<GlobalState> {
    if (this.state) {
      return this.state;
    }

    const file = Bun.file(STATE_FILE);

    if (!(await file.exists())) {
      this.state = { version: 1, repos: [] };
      return this.state;
    }

    try {
      const content = await file.text();
      const parsed = JSON.parse(content);
      const result = GlobalStateSchema.safeParse(parsed);

      if (!result.success) {
        // Invalid state file - reset to empty
        process.stderr.write(
          `Warning: Invalid global state file, resetting: ${result.error.message}\n`,
        );
        this.state = { version: 1, repos: [] };
        return this.state;
      }

      this.state = result.data;
      return this.state;
    } catch (err) {
      // Parse error - reset to empty
      process.stderr.write(`Warning: Failed to read global state file, resetting: ${err}\n`);
      this.state = { version: 1, repos: [] };
      return this.state;
    }
  }

  /**
   * Save state to disk.
   */
  private async save(): Promise<void> {
    if (!this.state) {
      throw new Error("Cannot save state before loading");
    }

    this.ensureDir();

    try {
      await Bun.write(STATE_FILE, JSON.stringify(this.state, null, 2) + "\n");
    } catch (err) {
      throw new Error(`Failed to write global state file ${STATE_FILE}: ${err}`);
    }
  }

  /**
   * Get all registered repository paths.
   */
  async getAll(): Promise<string[]> {
    const state = await this.load();
    return [...state.repos];
  }

  /**
   * Register a repository path. No-op if already registered.
   * Paths are normalized to avoid duplicates from symlinks or trailing slashes.
   */
  async register(repoPath: string): Promise<void> {
    const state = await this.load();

    // Normalize path to avoid duplicates (symlinks, trailing slashes)
    let normalizedPath: string;
    try {
      const realPath = await Bun.$`realpath ${repoPath}`.text();
      normalizedPath = realPath.trim();
    } catch {
      // Fall back to original path with trailing slashes removed
      normalizedPath = repoPath;
      while (normalizedPath.endsWith("/")) normalizedPath = normalizedPath.slice(0, -1);
    }

    if (state.repos.includes(normalizedPath)) {
      return; // Already registered
    }

    state.repos.push(normalizedPath);
    await this.save();
  }

  /**
   * Resolve a repository by name.
   *
   * Matching logic:
   * 1. Exact basename match (if unique)
   * 2. parent/name suffix match for disambiguation
   *
   * @returns ResolveResult indicating found, ambiguous, or not_found
   */
  async resolveByName(name: string): Promise<ResolveResult> {
    const state = await this.load();
    const repos = state.repos;

    // Try exact basename match
    const exactMatches = repos.filter((p) => basename(p) === name);
    if (exactMatches.length === 1) {
      return { status: "found", path: exactMatches[0]! };
    }
    if (exactMatches.length > 1) {
      return { status: "ambiguous", paths: exactMatches };
    }

    // Try parent/name suffix match (e.g., "work/loxel" matches "/home/user/work/loxel")
    const suffixMatches = repos.filter((p) => p.endsWith("/" + name));
    if (suffixMatches.length === 1) {
      return { status: "found", path: suffixMatches[0]! };
    }
    if (suffixMatches.length > 1) {
      return { status: "ambiguous", paths: suffixMatches };
    }

    return { status: "not_found" };
  }

  /**
   * Get display name for a repo path, including parent dir if needed for disambiguation.
   */
  getDisplayName(repoPath: string, allPaths: string[]): string {
    const name = basename(repoPath);
    const sameNameCount = allPaths.filter((p) => basename(p) === name).length;

    if (sameNameCount > 1) {
      // Include parent directory for disambiguation
      const parent = basename(dirname(repoPath));
      return `${parent}/${name}`;
    }

    return name;
  }
}
