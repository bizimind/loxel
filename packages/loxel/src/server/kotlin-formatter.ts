import { readFileSync, statSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join, resolve } from "node:path";

import {
  dirsUpToRoot,
  type FileFormatter,
  type FormatterDecline,
  type FormatterFailure,
  type FormatterSpawnOptions,
  type LanguageFormatter,
} from "./language-formatter";
import { pathOutsideWorktree } from "./python-env";
import { buildSpawnEnv } from "./shell-env";
import { isInside, isShippedByRepo } from "./shipped-by-repo";

export const kotlinFormatter: LanguageFormatter = {
  extensions: ["kt", "kts"],
  detect: detectKotlinFormatter,
  spawnOptions: kotlinSpawnOptions,
  failureNotice: kotlinFailureNotice,
};

/**
 * `--ignore-autocorrect-failures` (ktlint 1.8+): a violation ktlint cannot fix, which is the
 * linter's to report, would otherwise exit 1 and leave the fixable ones unformatted too. A syntax
 * error exits 0 with empty stdout, which format-service treats as no result.
 */
const KTLINT: FileFormatter = {
  command: "ktlint",
  args: "--stdin -F --ignore-autocorrect-failures --stdin-path={file} --log-level=none",
};

const KTFMT_PLUGIN = "com.ncorti.ktfmt.gradle";
/**
 * Plugin ids and the coordinates a `buildscript` classpath or a catalog library names them by.
 * kotlinter is a Gradle wrapper around ktlint's rules, configured by the same `.editorconfig`.
 */
const KTLINT_PLUGINS = [
  "org.jlleitschuh.gradle.ktlint",
  "org.jlleitschuh.gradle:ktlint-gradle",
  "org.jmailen.kotlinter",
  "org.jmailen.gradle:kotlinter-gradle",
];

const BUILD_SCRIPTS = ["build.gradle.kts", "build.gradle"];
const VERSION_CATALOG = join("gradle", "libs.versions.toml");
/** Every signal fits well below this; a larger file is not read, so a save cannot stall on it. */
const MAX_SIGNAL_FILE_SIZE = 1_024 * 1_024;

const KTLINT_PROPERTY = /^[ \t]*ktlint_[\w-]+[ \t]*=/im;
const EDITORCONFIG_ROOT = /^[ \t]*root[ \t]*=[ \t]*true[ \t]*$/im;

/** The `ktfmt {}` settings that select CLI flags; the plugin's default is the CLI's, Meta style. */
const KTFMT_STYLE_FLAGS = [
  [/\bkotlinLangStyle\s*\(/, "--kotlinlang-style"],
  [/\bgoogleStyle\s*\(/, "--google-style"],
] as const;
const KTFMT_KEEP_IMPORTS = /\bremoveUnusedImports\b(\s*\.\s*set\s*\(\s*|\s*=\s*)false/;
/** `ktfmt {}` settings with no CLI flag; the CLI would reflow code against them. */
const KTFMT_UNSUPPORTED =
  /\b(maxWidth|blockIndent|continuationIndent|trailingCommaManagementStrategy|manageTrailingCommas)\b/;
const KTFMT_BLOCK = /\b(?:ktfmt|configure<KtfmtExtension>)\s*\{/g;
const KTFMT_DOTTED_SETTING = /\bktfmt\s*\.\s*\w.*/g;
const KTFMT_SETTING = new RegExp(
  [...KTFMT_STYLE_FLAGS.map(([setting]) => setting), KTFMT_KEEP_IMPORTS, KTFMT_UNSUPPORTED]
    .map((setting) => setting.source)
    .join("|"),
);

/**
 * Pick the Kotlin formatter for files under `startDir`, walking up to `wtRoot`. Only reads files
 * as text: a Gradle build is code, and running it to ask would run the repository's code on save.
 *
 * The nearest directory with a signal decides, so each project in a monorepo can use its own. In
 * one directory ktfmt wins: formatting is its only job, while ktlint may be there just to lint. A
 * project with no signal formats nothing, like prettier and oxfmt need a config or dependency:
 * formatting a project with a tool it never chose would rewrite every file it saves. In particular,
 * a plain `[*.{kt,kts}]` section is not a signal, since it serves any editor, and neither is a
 * ktlint library in the version catalog (detekt's wrapper has one, without running ktlint).
 *
 * Not cached: a save costs a few small file reads per directory level, negligible next to spawning
 * the formatter.
 */
function detectKotlinFormatter(
  startDir: string,
  wtRoot: string,
): FileFormatter | FormatterDecline | null {
  const dirs = dirsUpToRoot(startDir, wtRoot);
  // A `root = true` file ends the search ktlint itself does, so what lies above it does not apply.
  let editorconfigApplies = true;
  for (const dir of dirs) {
    const declared = [...buildScripts(dir), readCode(join(dir, VERSION_CATALOG), "#")];
    if (declared.some((text) => declaresPlugin(text, KTFMT_PLUGIN))) return ktfmtFor(dirs);
    const editorconfig = editorconfigApplies ? readText(join(dir, ".editorconfig")) : "";
    if (KTLINT_PROPERTY.test(editorconfig)) return KTLINT;
    if (declared.some((text) => KTLINT_PLUGINS.some((id) => declaresPlugin(text, id)))) {
      return KTLINT;
    }
    if (EDITORCONFIG_ROOT.test(editorconfig)) editorconfigApplies = false;
  }
  return null;
}

/**
 * The ktfmt command matching the nearest build script's `ktfmt {}` settings, which may be in a
 * parent's `subprojects {}`. A decline when it sets something the command line cannot, so a save
 * does not fight the project's own `ktfmtFormat`.
 */
function ktfmtFor(dirs: string[]): FileFormatter | FormatterDecline {
  const settings =
    dirs
      .flatMap(buildScripts)
      .map(ktfmtSettings)
      .find((text) => KTFMT_SETTING.test(text)) ?? "";
  const unsupported = KTFMT_UNSUPPORTED.exec(settings)?.[0];
  if (unsupported) {
    return {
      notice: `Format on save skipped: this project sets ktfmt's "${unsupported}", which the ktfmt command can't apply. Format with Gradle's ktfmtFormat task instead.`,
    };
  }
  const flags = [
    ...KTFMT_STYLE_FLAGS.flatMap(([setting, flag]) => (setting.test(settings) ? [flag] : [])),
    ...(KTFMT_KEEP_IMPORTS.test(settings) ? ["--do-not-remove-unused-imports"] : []),
  ];
  return { command: "ktfmt", args: [...flags, "--stdin-name={file}", "-"].join(" ") };
}

/**
 * The text of a script's `ktfmt {}` blocks and `ktfmt.x` statements, since names like `maxWidth`
 * or Spotless's `ktfmt().googleStyle()` elsewhere in a build mean something else.
 */
function ktfmtSettings(script: string): string {
  const blocks = [...script.matchAll(KTFMT_BLOCK)].map((match) => {
    const start = match.index + match[0].length;
    let depth = 1;
    let end = start;
    while (end < script.length && depth > 0) {
      if (script[end] === "{") depth += 1;
      if (script[end] === "}") depth -= 1;
      end += 1;
    }
    return script.slice(start, end);
  });
  return [...blocks, ...(script.match(KTFMT_DOTTED_SETTING) ?? [])].join("\n");
}

/** A quoted plugin id: `id("x")`, `apply plugin: "x"`, a catalog's `id = "x"`, or `"x:plugin:1.0"`. */
function declaresPlugin(text: string, id: string): boolean {
  return ['"', "'"].some(
    (quote) => text.includes(`${quote}${id}${quote}`) || text.includes(`${quote}${id}:`),
  );
}

function buildScripts(dir: string): string[] {
  return BUILD_SCRIPTS.map((name) => readCode(join(dir, name), "//"));
}

/** The text of a file with its comments removed, so a commented-out plugin does not count. */
function readCode(path: string, lineComment: "//" | "#"): string {
  const text = readText(path);
  return lineComment === "#" ? text.replace(/#.*$/gm, "") : withoutComments(text);
}

const STRING_LITERAL = /"""[\s\S]*?"""|'''[\s\S]*?'''|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'/y;

/**
 * Removes Kotlin and Groovy comments. It has to know about strings: `"https://x"` holds no line
 * comment, and in `"**\/*.kt"` the `/*` opens no block comment. Kotlin's block comments nest.
 */
function withoutComments(script: string): string {
  let code = "";
  let i = 0;
  while (i < script.length) {
    if (script.startsWith("//", i)) {
      const lineEnd = script.indexOf("\n", i);
      i = lineEnd === -1 ? script.length : lineEnd;
    } else if (script.startsWith("/*", i)) {
      i = endOfBlockComment(script, i);
    } else {
      STRING_LITERAL.lastIndex = i;
      const literal = STRING_LITERAL.exec(script)?.[0] ?? script.charAt(i);
      code += literal;
      i += literal.length;
    }
  }
  return code;
}

function endOfBlockComment(script: string, start: number): number {
  let depth = 0;
  let i = start;
  while (i < script.length) {
    if (script.startsWith("/*", i)) {
      depth += 1;
      i += 2;
    } else if (script.startsWith("*/", i)) {
      depth -= 1;
      i += 2;
      if (depth === 0) return i;
    } else {
      i += 1;
    }
  }
  return i;
}

/**
 * The file's text, empty when it cannot be read (a missing file is the usual case) or is not a
 * regular file of a reasonable size: detection runs synchronously on every save.
 */
function readText(path: string): string {
  try {
    const info = statSync(path);
    if (!info.isFile() || info.size > MAX_SIGNAL_FILE_SIZE) return "";
    return readFileSync(path, "utf-8");
  } catch {
    return "";
  }
}

/** What to run, since Loxel never installs a formatter. */
const INSTALL_HINTS: Record<string, string> = {
  ktfmt: "brew install ktfmt",
  ktlint: "brew install ktlint",
};

const NO_JAVA = /Unable to locate a Java Runtime|\bjava: (command )?not found/i;
const UNKNOWN_FLAG = /no such option|unknown option/i;

function kotlinFailureNotice(failure: FormatterFailure): string | undefined {
  const { command } = failure;
  const install = INSTALL_HINTS[command];
  if (!install) return undefined;
  if (failure.kind === "not-installed") {
    return `Format on save skipped: this project uses ${command}, which is not on your PATH. Install it, for example with \`${install}\`.`;
  }
  if (NO_JAVA.test(failure.stderr)) {
    return `Format on save skipped: ${command} needs Java, which is not on your PATH. Install a JDK and add it to your PATH.`;
  }
  if (command === KTLINT.command && UNKNOWN_FLAG.test(failure.stderr)) {
    return "Format on save skipped: Loxel needs ktlint 1.8 or newer. Upgrade it, for example with `brew upgrade ktlint`.";
  }
  return undefined;
}

/**
 * Kotlin formatters come from the machine, never the worktree. Putting a project directory on
 * `PATH` would also let the `ktlint` launcher, a shell script, pick up a committed `java` or `sed`.
 *
 * They run from the home directory. Any `cwd` other than the worktree makes `{file}` absolute,
 * which ktlint needs: with a relative `--stdin-path` it misses the `.editorconfig` in its working
 * directory. And outside the repository, a version manager's shim on `PATH` does not pick its
 * version from a `.tool-versions` the repository ships, which can name a path inside it.
 */
async function kotlinSpawnOptions(
  command: string,
  _dir: string,
  wtRoot: string,
): Promise<FormatterSpawnOptions> {
  const root = resolve(wtRoot);
  return {
    env: { PATH: await trustedPath(command, root) },
    binDirs: [],
    ...(command in INSTALL_HINTS ? { cwd: homedir() } : {}),
  };
}

/**
 * The login-shell `PATH` without the worktree's directories, under any spelling of their path, or
 * an entry whose `command` is something the repository ships, such as a symlink leading back in.
 */
async function trustedPath(command: string, root: string): Promise<string> {
  const entries = pathOutsideWorktree(buildSpawnEnv().PATH ?? "", root).split(delimiter);
  const trusted = await Promise.all(entries.map((dir) => isTrustedPathEntry(dir, command, root)));
  return entries.filter((_, i) => trusted[i]).join(delimiter);
}

/** An entry that cannot be checked, typically a directory that does not exist, is not trusted. */
async function isTrustedPathEntry(dir: string, command: string, root: string): Promise<boolean> {
  // A relative entry would depend on the formatter's directory.
  if (!isAbsolute(dir)) return false;
  try {
    const [realDir, realRoot] = await Promise.all([realpath(dir), realpath(root)]);
    if (isInside(realDir, realRoot)) return false;
    const executable = Bun.which(command, { PATH: dir });
    if (!executable) return true;
    if (isInside(await realpath(executable), realRoot)) return false;
    return !(await isShippedByRepo(root, executable));
  } catch {
    return false;
  }
}
