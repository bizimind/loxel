import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/** The command a language module picked for a file. `{file}` / `{ext}` in `args` are substituted. */
export interface FileFormatter {
  command: string;
  args: string;
}

/** How to spawn a formatter. What a module leaves out keeps the default in `LanguageFormatter`. */
export interface FormatterSpawnOptions {
  /**
   * An existing directory; `dir` itself may not exist yet when saving a file whose folder is gone.
   * Other than the worktree, it makes `{file}` and a relative command absolute. Default: the worktree.
   */
  cwd?: string;
  /** Added to the login-shell environment. */
  env?: Record<string, string>;
  /** Prepended to `PATH`, first wins. Default: the worktree's `node_modules/.bin`. */
  binDirs?: readonly string[];
}

/**
 * A language's format-on-save rules, listed in `language-formatters.ts`. Unlike the worktree-root
 * `DETECTION_RULES` in `format-service.ts`, these resolve per file, typically from the nearest
 * config (see {@link dirsUpToRoot}).
 */
export interface LanguageFormatter {
  /** Lower-case file extensions without the dot. */
  extensions: readonly string[];
  /**
   * The formatter for files in `dir`, a directory inside the worktree `wtRoot`. Null leaves the
   * file to the next module claiming its extension, then to `DETECTION_RULES`, so a module taking
   * over a language removes its rule there. Runs on every save.
   */
  detect(dir: string, wtRoot: string): FileFormatter | null;
  /**
   * How to spawn `command` for files in `dir`. Runs for every command formatting these extensions,
   * manual overrides included, so an override gets the same `cwd`, `env` and `PATH`. Of several
   * modules claiming an extension, the first one's applies, even to a later module's formatter.
   */
  spawnOptions?(
    command: string,
    dir: string,
    wtRoot: string,
  ): FormatterSpawnOptions | Promise<FormatterSpawnOptions>;
}

/** The default of {@link FormatterSpawnOptions.binDirs}, for a module that adds to it. */
export function nodeModulesBin(wtRoot: string): string {
  return join(wtRoot, "node_modules", ".bin");
}

/** `startDir` and its ancestors up to `wtRoot` (inclusive); just `wtRoot` when outside it. */
export function dirsUpToRoot(startDir: string, wtRoot: string): string[] {
  const root = resolve(wtRoot);
  let dir = resolve(root, startDir);
  const rel = relative(root, dir);
  // Lexical check: callers pass the file path in the same form as the worktree path.
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return [root];
  const dirs = [dir];
  while (dir !== root) {
    dir = dirname(dir);
    dirs.push(dir);
  }
  return dirs;
}
