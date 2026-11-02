import { basename, dirname, join, resolve } from "node:path";

import {
  blockBodies,
  buildScripts,
  declaresPlugin,
  findKtlintProject,
  gradleDeclarations,
  readText,
} from "./kotlin-formatter";
import { dirsUpToRoot } from "./language-formatter";
import { isInside } from "./shipped-by-repo";

export interface DetektProject {
  tool: "detekt";
  root: string;
  /** The project's config files, later ones overriding; none runs detekt's defaults. */
  configs: string[];
  buildUponDefaultConfig: boolean;
  allRules: boolean;
}

export interface KtlintProject {
  tool: "ktlint";
  root: string;
}

export type KotlinLintProject = DetektProject | KtlintProject;
export type KotlinLintTool = KotlinLintProject["tool"];

/** Plugin ids of both lines (2.x renamed it), and the coordinates a `buildscript` classpath uses. */
const DETEKT_PLUGINS = [
  "dev.detekt",
  "dev.detekt:detekt-gradle-plugin",
  "io.gitlab.arturbosch.detekt",
  "io.gitlab.arturbosch.detekt:detekt-gradle-plugin",
];

/** By a directory: at its top, then where the Gradle plugin and common setups keep it. */
const DETEKT_CONFIG_PATHS = [
  "detekt.yml",
  "detekt.yaml",
  join("config", "detekt", "detekt.yml"),
  join("config", "detekt", "detekt.yaml"),
  join("config", "detekt.yml"),
  join("config", "detekt.yaml"),
];

const DETEKT_BLOCK = /\bdetekt\s*\{/g;
/** Quoted YAML paths, each after any leading `$rootDir/` or `${projectDir}/`. */
const NAMED_CONFIG = /["'](?:\$\{?[\w.]+\}?\/)?([^"'$\n]+\.ya?ml)["']/g;
const BUILD_UPON_DEFAULT_CONFIG = /\bbuildUponDefaultConfig\b(\s*\.\s*set\s*\(\s*|\s*=\s*|\s+)true/;
const ALL_RULES = /\ballRules\b(\s*\.\s*set\s*\(\s*|\s*=\s*|\s+)true/;
const CONFIG_SETTING = new RegExp(`${BUILD_UPON_DEFAULT_CONFIG.source}|${ALL_RULES.source}`);

const SIGNAL_FILES = new Set([
  ".editorconfig",
  "build.gradle",
  "build.gradle.kts",
  "libs.versions.toml",
  "detekt.yml",
  "detekt.yaml",
]);

/**
 * What lints `file`: at most one project per tool, each the nearest directory configured for it, so
 * each subproject of a monorepo can have its own. Reads files as text and runs nothing: a Gradle
 * build is code. No signal means no entry, and nothing runs.
 */
export function findKotlinLintProjects(file: string, wtRoot: string): KotlinLintProject[] {
  const startDir = dirname(file);
  const detekt = findDetektProject(startDir, wtRoot);
  const ktlint = findKtlintProject(startDir, wtRoot);
  return [
    ...(detekt ? [detekt] : []),
    ...(ktlint ? [{ tool: "ktlint", root: ktlint } as const] : []),
  ];
}

/** Whether a change to `file` can change what {@link findKotlinLintProjects} finds. */
export function isKotlinLintSignalFile(file: string): boolean {
  return SIGNAL_FILES.has(basename(file));
}

function findDetektProject(startDir: string, wtRoot: string): DetektProject | null {
  const dirs = dirsUpToRoot(startDir, wtRoot);
  const nearest = dirs.findIndex((dir) => hasDetektConfig(dir) || declaresDetekt(dir));
  if (nearest === -1) return null;
  const candidates = dirs.slice(nearest);
  const settings = candidates.map((dir) => ({
    dir,
    text: buildScripts(dir)
      .flatMap((script) => blockBodies(script, DETEKT_BLOCK))
      .join("\n"),
  }));
  const flags = settings.find(({ text }) => CONFIG_SETTING.test(text))?.text ?? "";
  return {
    tool: "detekt",
    root: candidates[0] ?? startDir,
    configs: namedConfigs(settings, candidates, wtRoot) ?? conventionalConfig(candidates),
    buildUponDefaultConfig: BUILD_UPON_DEFAULT_CONFIG.test(flags),
    allRules: ALL_RULES.test(flags),
  };
}

function hasDetektConfig(dir: string): boolean {
  return DETEKT_CONFIG_PATHS.some((path) => readText(join(dir, path)) !== "");
}

function declaresDetekt(dir: string): boolean {
  return gradleDeclarations(dir).some((text) =>
    DETEKT_PLUGINS.some((id) => declaresPlugin(text, id)),
  );
}

/** The nearest config at a conventional path, which may be above a subproject that applies the plugin. */
function conventionalConfig(dirs: string[]): string[] {
  for (const dir of dirs) {
    for (const path of DETEKT_CONFIG_PATHS) {
      const file = join(dir, path);
      if (readText(file) !== "") return [file];
    }
  }
  return [];
}

/**
 * The configs the nearest `detekt {}` block naming any lists, in its order. What a leading
 * `$rootDir/` stands for is Gradle's to know, so each path is tried from the script's directory up.
 * Null when none of them exists in the worktree.
 */
function namedConfigs(
  settings: { dir: string; text: string }[],
  dirs: string[],
  wtRoot: string,
): string[] | null {
  for (const { dir, text } of settings) {
    const above = dirs.slice(dirs.indexOf(dir));
    const found = [...text.matchAll(NAMED_CONFIG)].flatMap(([, path = ""]) => {
      const file = above
        .map((from) => resolve(from, path))
        .find((candidate) => isInside(candidate, resolve(wtRoot)) && readText(candidate) !== "");
      return file ? [file] : [];
    });
    if (found.length > 0) return found;
  }
  return null;
}
