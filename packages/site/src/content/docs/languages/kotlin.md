---
title: Kotlin
description: Editing Kotlin files in Loxel, with raw strings, backtick identifiers, and KDoc comments, plus format on save with ktfmt or ktlint and lint diagnostics from detekt and ktlint.
order: 13.5
---

Kotlin source (`.kt`) and script (`.kts`) files get highlighting and 4-space indentation.

## Editing Kotlin files

- Typing `"""` adds the closing quotes, and typing the closing quotes steps over them.
- Backticks pair, so typing `` ` `` adds the closing one, and pressing it with text selected wraps the selection. Handy for identifiers such as test names.
- Typing `/**` adds the closing `*/`. Pressing Enter inside a KDoc comment continues it with a new `*` line.
- Pressing Enter after a lambda's parameters, as in `list.map { x ->`, indents the next line.

## Format on save

Saving a Kotlin file formats it with [ktfmt](https://github.com/facebook/ktfmt) or [ktlint](https://pinterest.github.io/ktlint/), whichever the project uses. See [Formatter auto-detection](/docs/editor#formatter-auto-detection) for when formatting runs.

Loxel looks in the file's folder and up to the root of the worktree, so each project in a monorepo can use its own formatter. It reads these files and never runs your build:

- **ktfmt:** the `com.ncorti.ktfmt.gradle` plugin in `build.gradle.kts`, `build.gradle` or `gradle/libs.versions.toml`.
- **ktlint:** a `ktlint_*` property in `.editorconfig`, or the `org.jlleitschuh.gradle.ktlint` or `org.jmailen.kotlinter` plugin in those Gradle files.

The folder closest to the file decides, and ktfmt wins when one folder has both. A project with neither isn't formatted, not even one with a `[*.{kt,kts}]` section in `.editorconfig`; add a manual override in **Settings > Editor** if you want it formatted anyway. Spotless isn't detected, and neither are settings or plugins applied only from a convention plugin in `buildSrc` or `build-logic`: a ktfmt plugin found elsewhere then uses the default style.

Install the formatter yourself: Loxel runs it from your `PATH`, never from inside the worktree, and doesn't download anything. If it's missing, the save goes through unformatted and Loxel tells you what to run.

Run `brew install ktfmt` or `brew install ktlint`, or use another install method from the tool's site. ktlint must be version 1.8 or newer, and needs Java on your `PATH`.

**ktfmt** follows the `ktfmt {}` block of the closest build file that has one: `kotlinLangStyle()`, `googleStyle()` or the default style, and `removeUnusedImports` set to false. The `ktfmt` command can't apply `maxWidth`, `blockIndent`, `continuationIndent` or the trailing comma settings, so a project that sets any of them isn't formatted on save, since that would reflow its code against its own settings. Loxel tells you which setting it found, and Gradle's `ktfmtFormat` task still formats the project.

**ktlint** follows your `.editorconfig`, and fixes what it can. Violations it can't fix, such as a wildcard import, stay in the file for `ktlint` itself to report. A file with a syntax error is saved as you wrote it, with either tool.

## Lint diagnostics

If your project uses [detekt](https://detekt.dev) or [ktlint](https://ktlint.github.io/ktlint/), their findings appear in the editor with the tool's name, the tool's severity and a link to the rule's documentation. Both can run on the same file if the project uses both.

Loxel looks in the file's folder and up to the root of the worktree, and the closest folder configured for a tool applies, so each project in a monorepo can have its own setup. It reads these files and never runs your build:

- **detekt:** a `detekt.yml` or `detekt.yaml`, also under `config/` or `config/detekt/`, or the `dev.detekt` or `io.gitlab.arturbosch.detekt` plugin in `build.gradle.kts`, `build.gradle` or `gradle/libs.versions.toml`. The config files named in a `detekt {}` block are used, and so are its `buildUponDefaultConfig` and `allRules` settings.
- **ktlint:** the same signals as format on save, above.

A project with none of these runs nothing.

Install the tools yourself: Loxel runs them from your `PATH`, never from inside the worktree, and doesn't download anything. If one is missing, Loxel tells you once what to run, such as `brew install detekt` or `brew install ktlint`. Both need Java on your `PATH`.

Findings reflect saved files. A tool checks a file when you open it, and an open file again when it changes on disk or a config changes. Files you don't have open aren't checked, so a project-wide run in your terminal or CI can find more.

Detekt rule sets from plugins don't run here, and baselines aren't applied, so a finding your build has baselined still shows in the editor.
