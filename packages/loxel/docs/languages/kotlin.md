# Kotlin

Kotlin (`.kt`, `.kts`) has no language server for completions or navigation yet; its one server module is [lint diagnostics](#lint-diagnostics) from detekt and ktlint. Shared language-server architecture: [LANGUAGE_SERVERS.md](../LANGUAGE_SERVERS.md).

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

## Lint diagnostics

detekt and ktlint have no language server, so [kotlin-lint-lsp-manager.ts](../../src/server/kotlin-lint-lsp-manager.ts) is one, in-process, on its own route (`kotlin-lint-lsp`), built like mypy's ([Python](python.md#basedpyright-ruff-and-mypy)): `KotlinLintLspManager` keeps one session per worktree, answers `initialize` with open and close sync only, and sends `textDocument/publishDiagnostics` and `window/showMessage`. The client, [kotlin-lint-lsp-client.ts](../../src/lib/kotlin-lint-lsp-client.ts), sets `showMessages`.

**Detection.** [kotlin-lint-config.ts](../../src/server/kotlin-lint-config.ts) reads text and runs nothing, for each file on each run, so a config change needs no restart and a project with no signal starts no process. ktlint's signals are the formatter's (`findKtlintProject` in `kotlin-formatter.ts`), except that ktfmt does not take its place. detekt's nearest project is the nearest directory with `detekt.yml` or `detekt.yaml`, the same under `config/` or `config/detekt/`, or the `dev.detekt` or `io.gitlab.arturbosch.detekt` plugin in a build script or catalog. Its configs are what the nearest `detekt {}` block naming any lists, else the nearest conventional path at or above that project, else none (detekt's defaults). `buildUponDefaultConfig` and `allRules` come from the nearest block that sets them, since a partial config means something else without the former. Each tool has its own project root.

**What a run checks.** A JVM start takes 1 to 2 s of CPU, so a run covers open files only: a file when it opens, an open file when it changes on disk, every open file when a signal or a config in use changes. Changes are collected for 500 ms from the first one. Runs go one at a time per worktree, stricter than per project root, one tool and root after another, each in its own process group, killed whole after 60 s or when the session ends, and changes during a run wait for the next one. Results for a closed file are dropped, and anything a tool no longer reports, or a tool that failed or no longer applies, is cleared.

**Running a tool.** [kotlin-lint-runner.ts](../../src/server/kotlin-lint-runner.ts) takes the binary from `trustedPath` in `kotlin-formatter.ts` (see [Formatting](#formatting) for that rule) and runs it from the home directory. Gradle, Maven and wrappers are never run. Flags come from Loxel; only the config path and the files come from the project, and `--plugins`, `--classpath`, `--ruleset` and `--baseline` are never passed, so plugin rule sets and baselines are out of scope.

- **detekt** (tested: 1.23.8 and 2.0.0-alpha.6). `detekt` or `detekt-cli` on `PATH`. The two lines differ on the command line: 1.x takes one comma-separated `--input` and `--config` and rejects a repeat, 2.x repeats them and does not split, so the major version is read with `--version` once per binary, and again after a failed run. 1.x can't take a path with `,` or `;`, so such a file is skipped there and such a config is a failed run. A generated second `--config` sets `config.validation` to false, since a config for rule sets that don't run here (`ktlint`, `libraries`) otherwise exits 3. Reports are SARIF in a temporary directory, with exit 0 or 2 meaning a report: 1.x sets `level` on results, 2.x leaves it to the rule's `defaultConfiguration`, so a result's severity is its level, then its rule's, then `warning`. `--base-path` is the project root, against which rule `excludes` and 2.x's relative URIs resolve.
- **ktlint** (tested: 1.8.0). The JSON reporter writes to a file (`--reporter=json,output=`), not a standard stream. Only a parseable report counts, since exit 1 means both violations and a crash. A missing path makes ktlint walk the file system as a glob, so files are checked to exist just before. It has no severity field; its checkstyle report says `error`, so that is the severity. A syntax error comes as an entry with an empty rule.

A missing tool or JVM, or a failed run, is one `window/showMessage` per session, with the client dropping repeats across sessions. Rule links go to `https://detekt.dev/docs/rules/<rule set>#<rule>` and to ktlint's one page for standard rules, whose anchors follow titles rather than rule ids.
