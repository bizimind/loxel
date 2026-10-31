import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { $ } from "bun";

import { DEFAULT_FORMATTING_SETTINGS } from "@/lib/formatting-model";

import type { FileFormatter, FormatterDecline } from "./language-formatter";

// Reaches the Python module's state through `pathOutsideWorktree`; keep it out of the real store.
const stateDir = await mkdtemp(join(tmpdir(), "kotlin-formatter-state-"));
process.env.LOXEL_STATE_DIR = stateDir;
const { FormatService } = await import("./format-service");
const { kotlinFormatter } = await import("./kotlin-formatter");

const originalPath = process.env.PATH;
let root: string | undefined;

afterEach(async () => {
  process.env.PATH = originalPath;
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

afterAll(async () => {
  await rm(stateDir, { recursive: true, force: true });
});

/** A worktree below a temporary directory, so its parent is a directory of the test's own. */
async function makeWorktree(files: Record<string, string> = {}): Promise<string> {
  root = await realpath(await mkdtemp(join(tmpdir(), "kotlin-formatter-")));
  const wt = join(root, "wt");
  await mkdir(wt);
  for (const [name, content] of Object.entries(files)) {
    await mkdir(dirname(join(wt, name)), { recursive: true });
    await writeFile(join(wt, name), content);
  }
  return wt;
}

function detect(wt: string, dir = "src"): Partial<FileFormatter & FormatterDecline> | null {
  return kotlinFormatter.detect(join(wt, dir), wt);
}

const KTFMT_ID = "com.ncorti.ktfmt.gradle";
const ktfmtScript = (settings = "") =>
  `plugins { id("${KTFMT_ID}") version "0.26.0" }\nktfmt {\n  ${settings}\n}\n`;
const KTLINT_SCRIPT = 'plugins { id("org.jlleitschuh.gradle.ktlint") version "13.1.0" }\n';
const KTFMT_DEFAULT_ARGS = "--stdin-name={file} -";

describe("kotlinFormatter detection", () => {
  test("a project with no signal formats nothing", async () => {
    const wt = await makeWorktree({ "build.gradle.kts": 'plugins { kotlin("jvm") }\n' });
    expect(detect(wt)).toBeNull();
  });

  test("detects ktfmt from its plugin in build.gradle.kts", async () => {
    const wt = await makeWorktree({ "build.gradle.kts": ktfmtScript() });
    expect(detect(wt)).toEqual({ command: "ktfmt", args: KTFMT_DEFAULT_ARGS });
  });

  test("detects ktfmt from Groovy, the buildscript classpath and the version catalog", async () => {
    const groovy = await makeWorktree({ "build.gradle": `apply plugin: '${KTFMT_ID}'\n` });
    expect(detect(groovy)?.command).toBe("ktfmt");
    const classpath = await makeWorktree({
      "build.gradle": `buildscript { dependencies { classpath "${KTFMT_ID}:plugin:0.26.0" } }\n`,
    });
    expect(detect(classpath)?.command).toBe("ktfmt");
    const catalog = await makeWorktree({
      "gradle/libs.versions.toml": `[plugins]\nktfmt = { id = "${KTFMT_ID}", version = "0.26.0" }\n`,
    });
    expect(detect(catalog)?.command).toBe("ktfmt");
  });

  test("reads the plugin's style, and defaults to the CLI's Meta style like the plugin", async () => {
    const styles = [
      ["kotlinLangStyle()", "--kotlinlang-style"],
      ["googleStyle()", "--google-style"],
    ];
    for (const [setting, flag] of styles) {
      const wt = await makeWorktree({ "build.gradle.kts": ktfmtScript(setting) });
      expect(detect(wt)?.args).toBe(`${flag} ${KTFMT_DEFAULT_ARGS}`);
    }
  });

  test("finds the style in a parent's script when the catalog or a module has the plugin", async () => {
    const wt = await makeWorktree({
      "gradle/libs.versions.toml": `[plugins]\nktfmt = { id = "${KTFMT_ID}" }\n`,
      "build.gradle.kts": "subprojects { ktfmt { googleStyle() } }\n",
      "app/build.gradle.kts": "plugins { alias(libs.plugins.ktfmt) }\n",
    });
    expect(detect(wt, "app/src")?.args).toBe(`--google-style ${KTFMT_DEFAULT_ARGS}`);
  });

  test("the nearest script's style wins over a parent's", async () => {
    const wt = await makeWorktree({
      "build.gradle.kts": ktfmtScript("googleStyle()"),
      "app/build.gradle.kts": ktfmtScript("kotlinLangStyle()"),
    });
    expect(detect(wt, "app/src")?.args).toBe(`--kotlinlang-style ${KTFMT_DEFAULT_ARGS}`);
  });

  test("passes removeUnusedImports = false on, in both spellings", async () => {
    for (const setting of ["removeUnusedImports.set(false)", "removeUnusedImports = false"]) {
      const wt = await makeWorktree({ "build.gradle.kts": ktfmtScript(setting) });
      expect(detect(wt)?.args).toBe(`--do-not-remove-unused-imports ${KTFMT_DEFAULT_ARGS}`);
    }
  });

  test("declines with a reason when a ktfmt setting has no command line flag", async () => {
    const settings = [
      "maxWidth.set(120)",
      "blockIndent.set(8)",
      "continuationIndent.set(8)",
      "trailingCommaManagementStrategy.set(NONE)",
      "manageTrailingCommas = false",
    ];
    for (const setting of settings) {
      const wt = await makeWorktree({ "build.gradle.kts": ktfmtScript(setting) });
      const name = setting.split(/[.\s]/)[0]!;
      expect(detect(wt)).toEqual({ notice: expect.stringContaining(`ktfmt's "${name}"`) });
    }
  });

  test("detects ktlint from a ktlint_ property or a ktlint Gradle plugin", async () => {
    const property = await makeWorktree({
      ".editorconfig": "[*.{kt,kts}]\nktlint_code_style = ktlint_official\n",
    });
    expect(detect(property)?.command).toBe("ktlint");
    const plugin = await makeWorktree({ "build.gradle.kts": KTLINT_SCRIPT });
    expect(detect(plugin)?.command).toBe("ktlint");
    const kotlinter = await makeWorktree({
      "gradle/libs.versions.toml": '[plugins]\nkotlinter = { id = "org.jmailen.kotlinter" }\n',
    });
    expect(detect(kotlinter)?.command).toBe("ktlint");
  });

  test("a Kotlin .editorconfig section alone is not a signal, like a project of any editor", async () => {
    const wt = await makeWorktree({
      ".editorconfig": "root = true\n[*.{kt,kts}]\nindent_size = 4\nmax_line_length = 120\n",
    });
    expect(detect(wt)).toBeNull();
  });

  test("a ktlint library in the catalog is not a signal, as in detekt's own build", async () => {
    const wt = await makeWorktree({
      "gradle/libs.versions.toml":
        '[versions]\nktlint = "1.8.0"\n[libraries]\nktlint-rulesetStandard = { module = "com.pinterest.ktlint:ktlint-ruleset-standard", version.ref = "ktlint" }\n',
    });
    expect(detect(wt)).toBeNull();
  });

  test("a commented-out plugin or property does not count", async () => {
    const wt = await makeWorktree({
      "build.gradle.kts": `// id("${KTFMT_ID}")\n/* id("org.jmailen.kotlinter") */\nplugins { kotlin("jvm") }\n`,
      "gradle/libs.versions.toml": `# ktfmt = { id = "${KTFMT_ID}" }\n`,
      ".editorconfig": "[*.kt]\n# ktlint_code_style = ktlint_official\n",
    });
    expect(detect(wt)).toBeNull();
  });

  test("a nested block comment hides a plugin, as in Kotlin", async () => {
    const wt = await makeWorktree({
      "build.gradle.kts": `/* outer /* inner */ id("${KTFMT_ID}") */\n`,
    });
    expect(detect(wt)).toBeNull();
  });

  describe("a /* inside a Groovy block comment does not nest", () => {
    const header = "/*\n * Formats src/*.kt files\n */\n";

    test("the script after the comment still counts", async () => {
      const wt = await makeWorktree({
        "build.gradle": 'plugins { id "org.jlleitschuh.gradle.ktlint" }\n',
        "app/build.gradle": `${header}apply plugin: "${KTFMT_ID}"\n`,
      });
      expect(detect(wt, "app/src")?.command).toBe("ktfmt");
    });

    test("a ktfmt setting after the comment still declines", async () => {
      const wt = await makeWorktree({
        "app/build.gradle": `${header}apply plugin: "${KTFMT_ID}"\nktfmt { maxWidth = 120 }\n`,
      });
      expect(detect(wt, "app/src")?.notice).toContain("maxWidth");
    });

    test("text after the first */ is code, unlike in Kotlin", async () => {
      const groovy = await makeWorktree({
        "build.gradle": `/* outer /* inner */ apply plugin: "${KTFMT_ID}"\n`,
      });
      expect(detect(groovy)?.command).toBe("ktfmt");
    });

    test("an unclosed comment hides the rest of the script", async () => {
      const wt = await makeWorktree({ "build.gradle": `/* apply plugin: "${KTFMT_ID}"\n` });
      expect(detect(wt)).toBeNull();
    });
  });

  test("an apostrophe in a comment or a glob in a string does not confuse comment removal", async () => {
    const wt = await makeWorktree({
      "build.gradle.kts": `/* don't */ include("**/*.kt")\napply(plugin = "${KTFMT_ID}")\nktfmt { maxWidth.set(120) }\nexclude("**/*.kts")\n`,
    });
    expect(detect(wt)?.notice).toContain("maxWidth");
    const between = await makeWorktree({
      "build.gradle.kts": `target("**/*.kt")\napply(plugin = "${KTFMT_ID}")\nexclude("build/**/*.kt")\n`,
    });
    expect(detect(between)?.command).toBe("ktfmt");
  });

  test("reads ktfmt settings only from its own configuration", async () => {
    const outside = await makeWorktree({
      "build.gradle.kts": `${ktfmtScript()}val maxWidth = 1024\nspotless { kotlin { ktfmt().googleStyle() } }\n`,
    });
    expect(detect(outside)).toEqual({ command: "ktfmt", args: KTFMT_DEFAULT_ARGS });
    const parentWins = await makeWorktree({
      "build.gradle.kts": ktfmtScript("googleStyle()"),
      "app/build.gradle.kts": "val maxWidth = 1024\n",
    });
    expect(detect(parentWins, "app/src")?.args).toBe(`--google-style ${KTFMT_DEFAULT_ARGS}`);
    const forms = await makeWorktree({
      "build.gradle.kts": `plugins { id("${KTFMT_ID}") }\nktfmt.kotlinLangStyle()\n`,
      "app/build.gradle.kts": "configure<KtfmtExtension> { googleStyle() }\n",
    });
    expect(detect(forms)?.args).toBe(`--kotlinlang-style ${KTFMT_DEFAULT_ARGS}`);
    expect(detect(forms, "app/src")?.args).toBe(`--google-style ${KTFMT_DEFAULT_ARGS}`);
  });

  test("detects single-quoted and classpath forms of the plugins", async () => {
    const ktfmt = await makeWorktree({
      "build.gradle": `buildscript { dependencies { classpath '${KTFMT_ID}:plugin:0.26.0' } }\n`,
    });
    expect(detect(ktfmt)?.command).toBe("ktfmt");
    const ktlint = await makeWorktree({
      "build.gradle":
        "buildscript { dependencies { classpath 'org.jlleitschuh.gradle:ktlint-gradle:13.1.0' } }\n",
    });
    expect(detect(ktlint)?.command).toBe("ktlint");
  });

  test("ignores a signal file that is not a regular file of a reasonable size", async () => {
    const wt = await makeWorktree({
      "build.gradle.kts": `// ${"x".repeat(1_024 * 1_024)}\napply(plugin = "${KTFMT_ID}")\n`,
    });
    await symlink("/dev/zero", join(wt, ".editorconfig"));
    await mkdir(join(wt, "gradle"));
    await symlink("/dev/zero", join(wt, "gradle/libs.versions.toml"));
    expect(detect(wt)).toBeNull();
  });

  test("a URL on a plugin's line does not hide it", async () => {
    const wt = await makeWorktree({
      "build.gradle.kts": `val a = "https://x"; apply(plugin = "${KTFMT_ID}")\n`,
    });
    expect(detect(wt)?.command).toBe("ktfmt");
  });

  test("ktfmt wins over ktlint in one directory", async () => {
    const wt = await makeWorktree({
      "build.gradle.kts": ktfmtScript(),
      ".editorconfig": "[*.kt]\nktlint_code_style = ktlint_official\n",
    });
    expect(detect(wt)?.command).toBe("ktfmt");
  });

  test("the nearest directory with a signal decides, for each project in a monorepo", async () => {
    const wt = await makeWorktree({
      "build.gradle.kts": ktfmtScript(),
      "services/a/.editorconfig": "[*.kt]\nktlint_standard = enabled\n",
      "services/b/build.gradle.kts": KTLINT_SCRIPT,
      "services/c/src/.keep": "",
    });
    expect(detect(wt, "services/a/src")?.command).toBe("ktlint");
    expect(detect(wt, "services/b/src")?.command).toBe("ktlint");
    expect(detect(wt, "services/c/src")?.command).toBe("ktfmt");
  });

  test("a root .editorconfig cuts off ktlint properties above it, not plugins", async () => {
    const properties = await makeWorktree({
      ".editorconfig": "[*.kt]\nktlint_standard = enabled\n",
      "sub/.editorconfig": "root = true\n[*.kt]\nindent_size = 4\n",
    });
    expect(detect(properties, "sub/src")).toBeNull();
    const plugin = await makeWorktree({
      "build.gradle.kts": ktfmtScript(),
      "sub/.editorconfig": "root = true\n",
    });
    expect(detect(plugin, "sub/src")?.command).toBe("ktfmt");
  });

  test("does not look above the worktree", async () => {
    const wt = await makeWorktree();
    await writeFile(join(dirname(wt), "build.gradle.kts"), ktfmtScript());
    expect(detect(wt)).toBeNull();
  });
});

describe("kotlinFormatter spawning", () => {
  const REPORT = '#!/bin/sh\necho "$(basename "$0") from $0 cwd=$(pwd -P) args=$*"\n';

  async function install(dir: string, command: string, script = REPORT): Promise<string> {
    await mkdir(dir, { recursive: true });
    const file = join(dir, command);
    await writeFile(file, script, { mode: 0o755 });
    return file;
  }

  /** A machine-wide directory outside the worktree, first on `PATH`. */
  async function machineBin(wt: string, ...commands: string[]): Promise<string> {
    const bin = join(dirname(wt), "machine-bin");
    for (const command of commands) await install(bin, command);
    process.env.PATH = `${bin}:${originalPath}`;
    return bin;
  }

  function save(wt: string, file: string, content = "fun f() {}\n") {
    return new FormatService().format(content, file, wt, DEFAULT_FORMATTING_SETTINGS);
  }

  const NOT_INSTALLED = (command: string) =>
    `Format on save skipped: this project uses ${command}, which is not on your PATH. Install it, for example with \`brew install ${command}\`.`;

  const KTLINT_PROJECT = { ".editorconfig": "[*.kt]\nktlint_standard = enabled\n" };

  test("ktlint gets an absolute path, from outside the worktree, even for a relative save", async () => {
    const wt = await makeWorktree(KTLINT_PROJECT);
    const bin = await machineBin(wt, "ktlint");
    const result = await save(wt, "src/A.kt");
    expect(result.content).toBe(
      `ktlint from ${bin}/ktlint cwd=${await realpath(homedir())} args=--stdin -F --ignore-autocorrect-failures --stdin-path=${join(wt, "src/A.kt")} --log-level=none\n`,
    );
  });

  test("ktfmt also runs from outside the worktree, so nothing there picks its version", async () => {
    const wt = await makeWorktree({ "build.gradle.kts": ktfmtScript("kotlinLangStyle()") });
    const bin = await machineBin(wt, "ktfmt");
    const result = await save(wt, "src/A.kts");
    expect(result.content).toBe(
      `ktfmt from ${bin}/ktfmt cwd=${await realpath(homedir())} args=--kotlinlang-style --stdin-name=${join(wt, "src/A.kts")} -\n`,
    );
  });

  for (const [name, placement] of [
    ["the worktree root", "ktlint"],
    ["a project directory", "tools/ktlint"],
    ["node_modules/.bin", "node_modules/.bin/ktlint"],
  ] as const) {
    test(`a binary in ${name} does not run, even on PATH`, async () => {
      const wt = await makeWorktree(KTLINT_PROJECT);
      const shipped = await install(join(wt, dirname(placement)), "ktlint");
      await $`git init -q && git add -A && git -c user.name=t -c user.email=t@t commit -qm init`
        .cwd(wt)
        .quiet();
      process.env.PATH = `${dirname(shipped)}:.:${originalPath}`;
      const result = await save(wt, "A.kt");
      expect(result).toEqual({ content: null, notice: NOT_INSTALLED("ktlint") });
    });
  }

  test("a symlink on PATH that leads into the worktree does not run", async () => {
    const wt = await makeWorktree(KTLINT_PROJECT);
    const shipped = await install(wt, "ktlint");
    const bin = join(dirname(wt), "machine-bin");
    await mkdir(bin);
    await symlink(shipped, join(bin, "ktlint"));
    process.env.PATH = `${bin}:${originalPath}`;
    const result = await save(wt, "A.kt");
    expect(result.notice).toBe(NOT_INSTALLED("ktlint"));
  });

  test("the java a ktlint launcher finds cannot come from the worktree", async () => {
    const wt = await makeWorktree(KTLINT_PROJECT);
    await install(wt, "java", '#!/bin/sh\necho "worktree java"\n');
    const bin = join(dirname(wt), "machine-bin");
    await install(bin, "java", '#!/bin/sh\necho "machine java"\n');
    await install(bin, "ktlint", "#!/bin/sh\nexec java\n");
    process.env.PATH = `${wt}:${bin}:${originalPath}`;
    const result = await save(wt, "A.kt");
    expect(result.content).toBe("machine java\n");
  });

  test("a PATH entry that is a symlink into the worktree supplies no java either", async () => {
    const wt = await makeWorktree(KTLINT_PROJECT);
    await install(join(wt, "tools"), "java", '#!/bin/sh\necho "worktree java"\n');
    const outside = dirname(wt);
    await symlink(join(wt, "tools"), join(outside, "link"));
    const bin = join(outside, "machine-bin");
    await install(bin, "java", '#!/bin/sh\necho "machine java"\n');
    await install(bin, "ktlint", "#!/bin/sh\nexec java\n");
    process.env.PATH = `${join(outside, "link")}:${bin}:${originalPath}`;
    expect((await save(wt, "A.kt")).content).toBe("machine java\n");
  });

  test("a PATH entry that does not exist is dropped without losing the others", async () => {
    const wt = await makeWorktree(KTLINT_PROJECT);
    const bin = await machineBin(wt, "ktlint");
    process.env.PATH = `/nonexistent-loxel-dir:${bin}:${originalPath}`;
    expect((await save(wt, "A.kt")).content).toStartWith(`ktlint from ${bin}/ktlint `);
  });

  test("a formatter's empty output can never blank a file: ktlint on a syntax error", async () => {
    const wt = await makeWorktree(KTLINT_PROJECT);
    const bin = join(dirname(wt), "machine-bin");
    // What ktlint does with a file that does not parse: exit 0, nothing on stdout.
    await install(bin, "ktlint", '#!/bin/sh\necho "Not a valid Kotlin file" >&2\nexit 0\n');
    process.env.PATH = `${bin}:${originalPath}`;
    expect(await save(wt, "A.kt", "fun (((\n")).toEqual({ content: null });
  });

  test("a formatter that exits non-zero leaves the file alone: ktfmt on a syntax error", async () => {
    const wt = await makeWorktree({ "build.gradle.kts": ktfmtScript() });
    const bin = join(dirname(wt), "machine-bin");
    await install(bin, "ktfmt", '#!/bin/sh\necho "A.kt:1:6: error" >&2\nexit 1\n');
    process.env.PATH = `${bin}:${originalPath}`;
    expect(await save(wt, "A.kt", "fun (((\n")).toEqual({ content: null });
  });

  test("a missing formatter gets the format notice", async () => {
    const wt = await makeWorktree({ "build.gradle.kts": ktfmtScript() });
    process.env.PATH = "/usr/bin:/bin";
    const result = await save(wt, "A.kt");
    expect(result).toEqual({ content: null, notice: NOT_INSTALLED("ktfmt") });
  });

  for (const [name, stderr] of [
    ["the macOS stub", "The operation couldn’t be completed. Unable to locate a Java Runtime."],
    ["sh", "/usr/local/bin/ktlint: 10: exec: java: not found"],
    ["bash", "/usr/local/bin/ktlint: line 10: java: command not found"],
  ] as const) {
    test(`ktlint with no JVM says so (${name})`, async () => {
      const wt = await makeWorktree(KTLINT_PROJECT);
      const bin = join(dirname(wt), "machine-bin");
      await install(bin, "ktlint", `#!/bin/sh\necho "${stderr}" >&2\nexit 127\n`);
      process.env.PATH = `${bin}:${originalPath}`;
      const result = await save(wt, "A.kt");
      expect(result.content).toBeNull();
      expect(result.notice).toContain("ktlint needs Java");
    });
  }

  test("a ktfmt launcher with no JVM says so too", async () => {
    const wt = await makeWorktree({ "build.gradle.kts": ktfmtScript() });
    const bin = join(dirname(wt), "machine-bin");
    await install(bin, "ktfmt", '#!/bin/sh\necho "exec: java: not found" >&2\nexit 127\n');
    process.env.PATH = `${bin}:${originalPath}`;
    expect((await save(wt, "A.kt")).notice).toContain("ktfmt needs Java");
  });

  test("a ktlint too old for the flags says so", async () => {
    const wt = await makeWorktree(KTLINT_PROJECT);
    const bin = join(dirname(wt), "machine-bin");
    const stderr = "Error: no such option --ignore-autocorrect-failures";
    await install(bin, "ktlint", `#!/bin/sh\necho "${stderr}" >&2\nexit 1\n`);
    process.env.PATH = `${bin}:${originalPath}`;
    expect((await save(wt, "A.kt")).notice).toContain("ktlint 1.8 or newer");
  });

  test("a declined project runs nothing and says why, and isn't listed as detected", async () => {
    const wt = await makeWorktree({ "build.gradle.kts": ktfmtScript("maxWidth.set(120)") });
    await machineBin(wt, "ktfmt");
    const service = new FormatService();
    const result = await service.format("x", "A.kt", wt, DEFAULT_FORMATTING_SETTINGS);
    expect(result.content).toBeNull();
    expect(result.notice).toContain(`ktfmt's "maxWidth"`);
    expect(service.getDetectedFormatters(wt).map((f) => f.command)).not.toContain("ktfmt");
  });

  test("a project with no signal runs nothing", async () => {
    const wt = await makeWorktree({ "build.gradle.kts": 'plugins { kotlin("jvm") }\n' });
    await machineBin(wt, "ktlint", "ktfmt");
    expect(await save(wt, "A.kt")).toEqual({ content: null });
  });

  test("a manual override keeps the worktree as its directory", async () => {
    const wt = await makeWorktree();
    const bin = await machineBin(wt, "my-kotlin-fmt");
    const result = await new FormatService().format("x", "A.kt", wt, {
      ...DEFAULT_FORMATTING_SETTINGS,
      overrides: [{ id: "o", extensions: "kt", command: "my-kotlin-fmt", args: "{file}" }],
    });
    expect(result.content).toBe(`my-kotlin-fmt from ${bin}/my-kotlin-fmt cwd=${wt} args=A.kt\n`);
  });
});
