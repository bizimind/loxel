import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { findKotlinLintProjects, isKotlinLintSignalFile } from "./kotlin-lint-config";

let wt: string;

afterEach(async () => {
  await rm(wt, { recursive: true, force: true });
});

async function worktree(files: Record<string, string>): Promise<void> {
  wt = await mkdtemp(join(tmpdir(), "kotlin-lint-config-"));
  await Promise.all(
    Object.entries(files).map(async ([path, text]) => {
      await mkdir(dirname(join(wt, path)), { recursive: true });
      await writeFile(join(wt, path), text);
    }),
  );
}

function projects(file: string): ReturnType<typeof findKotlinLintProjects> {
  return findKotlinLintProjects(join(wt, file), wt);
}

const detektDefaults = { tool: "detekt", buildUponDefaultConfig: false, allRules: false };

describe("findKotlinLintProjects", () => {
  test("no signal: nothing applies, not even with a plain editorconfig section", async () => {
    await worktree({
      ".editorconfig": "[*.{kt,kts}]\nindent_size = 4\n",
      "build.gradle.kts": 'plugins { kotlin("jvm") }\n',
    });
    expect(projects("src/A.kt")).toEqual([]);
  });

  test.each(["detekt.yml", "detekt.yaml", "config/detekt/detekt.yml", "config/detekt.yml"])(
    "a config at %s opts in",
    async (path) => {
      await worktree({ [path]: "style:\n  active: true\n" });
      expect(projects("src/A.kt")).toEqual([
        { ...detektDefaults, tool: "detekt", root: wt, configs: [join(wt, path)] },
      ]);
    },
  );

  test.each(["dev.detekt", "io.gitlab.arturbosch.detekt"])(
    "the Gradle plugin %s opts in, with detekt's defaults",
    async (id) => {
      await worktree({ "build.gradle.kts": `plugins { id("${id}") version "1.0" }\n` });
      expect(projects("A.kt")).toEqual([
        { ...detektDefaults, tool: "detekt", root: wt, configs: [] },
      ]);
    },
  );

  test("a commented-out plugin does not", async () => {
    await worktree({ "build.gradle.kts": '// plugins { id("dev.detekt") }\n' });
    expect(projects("A.kt")).toEqual([]);
  });

  test("the plugin in a version catalog opts in", async () => {
    await worktree({
      "gradle/libs.versions.toml": '[plugins]\ndetekt = { id = "dev.detekt", version = "2" }\n',
    });
    expect(projects("A.kt")).toEqual([
      { ...detektDefaults, tool: "detekt", root: wt, configs: [] },
    ]);
  });

  test("the nearest project applies in a monorepo, each with its own config", async () => {
    await worktree({
      "detekt.yml": "a: 1\n",
      "sub/detekt.yml": "b: 1\n",
      "sub/.editorconfig": "[*]\nktlint_code_style = android_studio\n",
    });
    expect(projects("sub/src/A.kt")).toEqual([
      {
        ...detektDefaults,
        tool: "detekt",
        root: join(wt, "sub"),
        configs: [join(wt, "sub/detekt.yml")],
      },
      { tool: "ktlint", root: join(wt, "sub") },
    ]);
    expect(projects("other/A.kt")).toEqual([
      { ...detektDefaults, tool: "detekt", root: wt, configs: [join(wt, "detekt.yml")] },
    ]);
  });

  test("a subproject applying the plugin uses the config above it", async () => {
    await worktree({
      "config/detekt/detekt.yml": "a: 1\n",
      "sub/build.gradle.kts": 'plugins { id("dev.detekt") }\n',
    });
    expect(projects("sub/A.kt")).toEqual([
      {
        ...detektDefaults,
        tool: "detekt",
        root: join(wt, "sub"),
        configs: [join(wt, "config/detekt/detekt.yml")],
      },
    ]);
  });

  test("a detekt block's config and settings apply, also from a parent's build script", async () => {
    await worktree({
      "lint/rules.yaml": "a: 1\n",
      "detekt.yml": "ignored: true\n",
      "build.gradle.kts": `plugins { id("dev.detekt") }
subprojects {
  detekt {
    buildUponDefaultConfig = true
    allRules.set(true)
    config.setFrom(files("$rootDir/lint/rules.yaml"))
  }
}
`,
      "sub/build.gradle.kts": 'plugins { id("dev.detekt") }\n',
    });
    expect(projects("sub/A.kt")).toEqual([
      {
        tool: "detekt",
        root: join(wt, "sub"),
        configs: [join(wt, "lint/rules.yaml")],
        buildUponDefaultConfig: true,
        allRules: true,
      },
    ]);
  });

  test("every config a detekt block lists applies, in order", async () => {
    await worktree({
      "a.yml": "a: 1\n",
      "b.yml": "b: 1\n",
      "build.gradle.kts": `plugins { id("dev.detekt") }
detekt { config.setFrom(files("a.yml", "$projectDir/b.yml", "missing.yml")) }
`,
    });
    expect(projects("A.kt")).toEqual([
      {
        ...detektDefaults,
        tool: "detekt",
        root: wt,
        configs: [join(wt, "a.yml"), join(wt, "b.yml")],
      },
    ]);
  });

  test("a config path leading out of the worktree is not used", async () => {
    await worktree({
      "build.gradle.kts": `plugins { id("dev.detekt") }
detekt { config.setFrom("../../outside.yml") }
`,
    });
    expect(projects("A.kt")).toEqual([
      { ...detektDefaults, tool: "detekt", root: wt, configs: [] },
    ]);
  });

  test("ktlint comes from the formatter's signals, even next to ktfmt", async () => {
    await worktree({
      "build.gradle.kts": `plugins {
  id("com.ncorti.ktfmt.gradle")
  id("org.jlleitschuh.gradle.ktlint")
}
`,
    });
    expect(projects("A.kt")).toEqual([{ tool: "ktlint", root: wt }]);
  });

  test("properties above a root editorconfig do not signal ktlint", async () => {
    await worktree({
      ".editorconfig": "[*]\nktlint_code_style = ktlint_official\n",
      "sub/.editorconfig": "root = true\n[*]\nindent_size = 2\n",
    });
    expect(projects("sub/A.kt")).toEqual([]);
    expect(projects("A.kt")).toEqual([{ tool: "ktlint", root: wt }]);
  });

  test("a directory named like a config is no signal", async () => {
    await worktree({ "detekt.yml/x": "a\n" });
    expect(projects("A.kt")).toEqual([]);
  });
});

test("isKotlinLintSignalFile", () => {
  expect(isKotlinLintSignalFile("/w/sub/detekt.yml")).toBe(true);
  expect(isKotlinLintSignalFile("/w/gradle/libs.versions.toml")).toBe(true);
  expect(isKotlinLintSignalFile("/w/.editorconfig")).toBe(true);
  expect(isKotlinLintSignalFile("/w/src/A.kt")).toBe(false);
});
