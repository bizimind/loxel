# Kotlin

Kotlin (`.kt`, `.kts`) has no language server module yet. Shared language-server architecture: [LANGUAGE_SERVERS.md](../LANGUAGE_SERVERS.md).

## Editing behavior

[kotlin-language-config.ts](../../src/lib/kotlin-language-config.ts) re-registers Monaco's Kotlin `conf` after the built-in registration, in the same order as Python's (see [Highlighting and language resolution](../LANGUAGE_SERVERS.md#highlighting-and-language-resolution)), with raw string and backtick pairs, `notIn` conditions on the quote pairs, and on-enter rules for KDoc and lambdas with parameters. `kotlin-language-config.test.ts` exercises it under the Shiki tokenizer the app uses, since `notIn` reads token types.

## Formatting

[kotlin-formatter.ts](../../src/server/kotlin-formatter.ts) is the `LanguageFormatter` for `.kt` and `.kts` (seam: [Formatting](../LANGUAGE_SERVERS.md#formatting)). Spotless and running Gradle or Maven are out of scope: both would run build code on save, with a cold run measured at 12-88 s and build output on stdout.

Detection reads files as text with comments removed, by each file's own rules (block comments nest in `.kts` and not in Groovy), and runs nothing, skipping anything that is not a regular file of at most 1 MiB, since detection is synchronous. Walking from the file's directory to the worktree root, the nearest directory with a signal decides, and within one directory ktfmt beats ktlint, since formatting is ktfmt's only job while ktlint may be there just to lint:

- **ktfmt:** `com.ncorti.ktfmt.gradle` in `build.gradle.kts`, `build.gradle` or `gradle/libs.versions.toml`.
- **ktlint:** a `ktlint_*` property in `.editorconfig` (properties above a `root = true` file do not count, as in ktlint's own lookup), or `org.jlleitschuh.gradle.ktlint` or `org.jmailen.kotlinter` in the same Gradle files.

A plain `[*.{kt,kts}]` section is not a signal, since it serves any editor, and neither is a ktlint library in the catalog, which detekt's build has without running ktlint.

A declaration counts even with `apply false` or only in the catalog, because a root that declares a plugin for its modules looks the same as text.

The nearest build script with settings in a `ktfmt {}` or `configure<KtfmtExtension> {}` block or a `ktfmt.x` statement selects the flags: `kotlinLangStyle()`, `googleStyle()`, no flag for the plugin's default (Meta, also the CLI's), and `removeUnusedImports` set to false. `maxWidth`, `blockIndent`, `continuationIndent`, `trailingCommaManagementStrategy` and `manageTrailingCommas` have no CLI flag and the CLI would reflow code against them, so `detect` returns a `FormatterDecline` naming the setting. ktfmt's `--enable-editorconfig` is not passed, because the Gradle plugin does not read `.editorconfig`.

ktlint runs with `--ignore-autocorrect-failures` (1.8+). Without it a violation with no autocorrect, such as a wildcard import, exits 1 and the fixable violations would be lost too. A syntax error exits 0 with empty stdout, which `FormatService` treats as no result.

Both run from the home directory. Any `cwd` other than the worktree makes `{file}` absolute, and with a relative `--stdin-path` ktlint 1.8 does not see the `.editorconfig` in its working directory. Outside the repository, a version manager's shim also cannot take its version from a `.tool-versions` the repository ships, so a project-only pin does not apply.

Their `PATH` is the login-shell one without the worktree's directories under any spelling (`realpath`), relative or missing entries, or an entry whose binary resolves into the worktree or is shipped by the repository (`isShippedByRepo`), and `binDirs` is empty. An untracked project binary is not supported either: `detect` is synchronous, so it cannot return a checked path, and a project directory on `PATH` would let the `ktlint` launcher, a shell script, run a committed `java` or `sed`.

`failureNotice` says what to run for a missing binary, recognizes no JVM from stderr (the launcher starts and fails, with exit 1 from the macOS `java` stub, 127 elsewhere) and a ktlint without the flag, and returns nothing for other exits, typically a syntax error.
