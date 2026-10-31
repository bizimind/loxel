# Java

Java files are served by Eclipse JDT LS (jdtls), which Loxel bundles and runs on the user's JDK, and every Java feature shares one per-worktree JDK choice. Shared language-server architecture: [LANGUAGE_SERVERS.md](../LANGUAGE_SERVERS.md).

## Manager

| Manager                                                     | Binary                    | Args        | Scope    | Flags and config                                                                                                                                                  |
| ----------------------------------------------------------- | ------------------------- | ----------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [java-lsp-manager.ts](../../src/server/java-lsp-manager.ts) | the user's JDK 25+ `java` | `jdtlsArgs` | worktree | watched files; settings at `initialize` and pushed after `initialized` and when JDKs change; per-file indentation pulled; drops `willRename` and two code actions |

## Binary

[download-jdtls.ts](../../scripts/download-jdtls.ts) fetches the jdtls release, one archive for every platform, unmodified apart from an added `LICENSE` and `NOTICE` at its top level, about 53 MiB. The `jdtls` directory is in `UPDATE_RESOURCE_DIRS`, since stale jars next to new ones would break the server. The macOS natives inside its jars are signed by the Eclipse Foundation, and natives for other platforms stay inside jars, so no foreign binary sits loose in the app.

## Choosing the JVM

jdtls itself needs Java 25, although `bin/jdtls.py` says 21: on 21 the JVM exits with code 13 without answering `initialize`, and the reason is only in a log. `resolveBinary` runs the newest entry of `listJavaRuntimes` at that level or above, by absolute path through `javaExecutable`, which the [trust rule](#jdk-detection) has already passed. There is no `PATH` lookup and nothing else runs a `java`. Without one it starts nothing and `serverFailureReason` says what to install.

The client then stops. `subscribeJavaStatus` in [java-toolchain-status.ts](../../src/server/java-toolchain-status.ts) reports a change when a JDK that can run the server appears or goes, even though the worktree's own JDK stays the same, and [java-server-recovery.ts](../../src/lib/java-server-recovery.ts) reconnects the Java client on that message if it stopped because it could not start, so installing one brings the server back. A client stopped for another reason stays stopped, in particular one another window took over.

## Java levels

`javaRuntimesSetting` turns `listJavaRuntimes` into `java.configuration.runtimes`: the newest JDK of each level, with `sources` from its `src.zip`, which is where hover documentation comes from. The worktree's JDK from `getJavaEnv` takes its level's place and is `default`, so the JVM's own level does not decide what a project compiles against. The manager follows `subscribeJavaEnv` and pushes the setting when it differs, so a JDK installed or chosen while the server runs applies without a restart.

## Starting the server

The JDK's `java` runs directly, with `-jar` on the launcher and no shell.

- `-configuration` is writable, in `<state>/jdtls/configuration/<core plugin file name>`, because the signed app is not. `osgi.sharedConfiguration.area` points read-only at the bundled `config_<platform>`.
- `-data` is per worktree path, `<state>/jdtls/data/<hash>`, since two same-named projects in one directory collide. It is deleted when the worktree is removed, in Loxel or from outside it, or when the server exits if it was still running then. A moved worktree starts a new one. A new server waits for the previous one on its worktree to exit first, since the directory takes one server at a time, and the JVM's working directory is this directory rather than the worktree.
- `serverFailureReason` reports the last `!MESSAGE` of the newest log written since the server started in the configuration directory, which is the only place a JVM that cannot start explains why.
- `-Xmx1G` with `ParallelGC` tuned to return memory. Resident memory is about 900 MB on a project of 300 files, most of it not heap: a cap of 512 MB saves 50 MB and one of 256 MB starts slower and still leaves 640 MB.

## Project import off

The server starts with project import off and makes no network requests.

- `java.import.maven.enabled` and `java.import.gradle.enabled` are false, `java.import.exclusions` is `["**"]` and `java.autobuild.enabled` is false. Each session gets them in `initializationOptions`, because jdtls reads those before its first import, and again through `workspace/didChangeConfiguration`. `notifyConfigurationChanged` sends `settings: null`, which jdtls ignores.
- `-Djava.import.generatesMetadataFilesAtProjectRoot=false` is a JVM property, not a setting; as a setting it does nothing.
- `-Djdk.net.hosts.file` points at a file naming only `localhost`.
- [audit-jdtls.ts](../../scripts/network-audit/audit-jdtls.ts) checks all of this through the built `loxel-server`, on opening files and on every command a user can reach, with `--control` as its positive control. Run it after changing the pin or the manager.

Each folder gets one invisible project. jdtls infers its source root from the first Java file it hears about, and `initialize` comes before any file opens, so `firstJavaFile`, a pruned walk that runs while the session's frames are held, passes one as `triggerFiles`. A file with a build file in its folder or above stays outside any project, and reports "non-project file" or "not on the classpath", "only syntax errors are reported". [JavaRuntimeStatus.tsx](../../src/components/panels/JavaRuntimeStatus.tsx) says so in the status bar while such a file is active, from `POST /api/java-env/build-file`, where `nearestBuildTool` looks for the same build files without reading or running them.

## Client capabilities

`extendedClientCapabilities` is not sent, so code actions come back with `data` and resolve to plain edits. jdtls resolves only the actions of its latest answer.

- `workspace.fileOperations.willRename` is removed from the `initialize` response. jdtls's rename edit already holds every reference, and `WorkspaceEditApplier` asks `willRenameFiles` for each rename operation in an edit, so a class rename would be applied twice.
- `dropUnusableActions` removes the actions that run `java.action.applyRefactoringCommand`, a client command that needs a prompt, and `Ignore compiler problem(s)`, which has neither an edit nor a command.
- Lenses are off (`referencesCodeLens`, `implementationCodeLens`), since their commands are the client's own in VS Code.
- `language/status`, `language/eventNotification` and the other custom notifications reach the client, which drops them with a debug log. `ServiceReady` does not mean analysis finished, so tests wait for diagnostics on an opened file.

## Settings it pulls

jdtls pulls only `java.format.tabSize` and `java.format.insertSpaces`, per file, to indent the code it generates. `workspaceConfiguration` answers from the file's first indented line.

## Watched files

jdtls registers its watchers after `ServiceReady`, as `**/*.java`-style globs, absolute globs, and `{baseUri, pattern}` entries in `file:/` single-slash form. The base forwards all three. Changes from `git checkout` and agents reach it the same way.

## JDK detection

[java-env.ts](../../src/server/java-env.ts) is the single resolver of a worktree's JDK, and of the JDKs on the machine, for every feature that needs one. It returns a `JavaEnv` from [java-env-model.ts](../../src/api/java-env-model.ts): a `JavaRuntime` (`path` of the JDK home, `majorVersion`, `version`, `implementor`) and its `source`.

- **What counts as a JDK.** `readJdk` reads a home without running anything: `bin/java` and `bin/javac` executable, `lib/ct.sym` or a `jmods` directory (JDK 24 made `jmods` optional and Temurin 25 has none; earlier builds have both), and a `release` file whose `JAVA_VERSION` parses. A JRE and a `jlink` runtime have no `javac` or `ct.sym`, and a wrapper script has no `release`. `jdkAt` accepts a directory as the home itself, as a macOS bundle (`Contents/Home`), or as Homebrew's formula directory (`libexec/openjdk.jdk/Contents/Home`, or `libexec` on Linux).
- **Resolution.** `resolveJavaEnv(wtPath, options)` tries, first hit wins: the chosen override, `JAVA_HOME`, the JDKs `/usr/libexec/java_home -V` lists, the JDK of the first real `java` on the login-shell `PATH`, then the install locations of `javaInstallRoots`. Several in one source: the newest wins, by Java level and then the rest of the version. That needs no configuration and matches `java_home`'s own default; pinning a version per project is out of scope here. It never throws. An invalid `JAVA_HOME` is reported as `ignoredJavaHome`, since a stale value is common and otherwise looks like a detection bug.
- **Nothing is run.** No `java` is ever executed. The only process resolution starts itself is `java_home`, which on a Mac without Java prints an error and exits 1 without a dialog (the dialog is `--request`, never passed); git runs for the trust rule below. `isMacOsJavaStub` recognizes `/usr/bin/java`, Apple's launcher that may offer to install Java when run. A version manager's shim is a script outside any JDK, so it fails `readJdk` and the search moves to the next `PATH` entry. Nothing is downloaded or installed: Loxel never fetches a toolchain itself.
- **Trust rule.** `isJdkShippedByRepo` applies the [environment trust rule](python.md#environment-trust-rule) through `isEnvShippedByRepo` from [shipped-by-repo.ts](../../src/server/shipped-by-repo.ts): a JDK with any file git tracks, or whose `java` or its symlink target is tracked, is refused from every source. It also refuses a home that is, or holds, the worktree, where that rule looks only at a Python environment's own entries. The path a JDK was found through is checked as well, and on `PATH` the `java` itself, since a committed symlink can reach a real JDK.
- **Shared resolution.** `subscribeJavaEnv(wtPath, listener)` keeps a worktree's resolution memoized while anyone is subscribed, and `getJavaEnv(wtPath)` answers from it (an unsubscribed worktree resolves afresh). Subscribing starts nothing: the first `getJavaEnv` does, so a worktree without Java spawns nothing and adds no watches. The memo is replaced on the shared watch, on `refreshJavaEnv` (the override changed), on `refreshAllJavaEnvs(changedNames)` when a login-shell capture changed a variable resolution reads, and when `getJavaEnv` finds the repository now tracks the settled JDK. Listeners hear every finished resolution as `{ env, first, changed }`, also when the JDK stayed the same, since another may have appeared. Through [java-toolchain-status.ts](../../src/server/java-toolchain-status.ts), each worktree's resources subscribe and send `java_env_changed` when `changed` (see [Toolchain status items](../LANGUAGE_SERVERS.md#toolchain-status-items)).
- **All JDKs.** `listJavaRuntimes(wtPath)` returns every usable JDK from every source, each once by physical path, newest first, so the first of a `majorVersion` is the newest of that level. It is what a feature needing one JDK per Java level consumes.
- **Watching.** One watch serves every resolved worktree (`syncSharedWatch`), rebuilt only when its targets change, and debounced: each install root, unfiltered; a missing root's deepest existing ancestor, for the next path segment; an entry of a root that is not a complete JDK yet, since an installer filling it is not reported by the root's non-recursive watch; and each `JAVA_HOME`, chosen or resolved home, for being removed, replaced or created. Roots are this platform's only, a filesystem root is never watched, and a replaced watch overlaps its replacement for a moment, since a platform watch can start late. A `java` appearing on `PATH` is not watched: the login-shell capture covers a changed `PATH`, and JDKs reach `PATH` through the watched locations. A non-recursive watch of a home directory costs little: 80,000 file events below the watched directory took about 250 ms of CPU, measured on macOS.
- **Choosing a JDK.** `normalizeJavaOverride(wtPath, input)` turns a path the user entered (`~/` allowed, a home, bundle, Homebrew directory or `bin/java`) into a JDK home, or throws a user-facing error. [java-override-store.ts](../../src/server/java-override-store.ts) stores the choice per worktree in `stores.db`, and it is deleted with the worktree. Because the resolver reads it, every feature gets the choice without state of its own. An override that stops qualifying falls through to detection and stays stored, so the status bar can warn.
- **API.** `GET /api/java-env?wt=` returns `{ env, overridePath, ignoredJavaHome }`; `GET /api/java-env/candidates?wt=` returns `{ candidates, automatic, overridePath }`; `POST /api/java-env/override` with `{ worktreePath, javaHome }` validates and stores the choice (`null` clears it) and answers like the first route. `wt` must be a worktree of a registered project. The routes are in [java-toolchain-status.ts](../../src/server/java-toolchain-status.ts), and the renderer calls them from [java-env-client.ts](../../src/api/java-env-client.ts). The renderer side is [java-runtime.ts](../../src/lib/java-runtime.ts) (labels and the picker, run by the `java.selectRuntime` action) and [JavaRuntimeStatus.tsx](../../src/components/panels/JavaRuntimeStatus.tsx) in the status bar, shown while the active editor's file resolves to Java, both registered in [java-toolchain-status.ts](../../src/lib/java-toolchain-status.ts).
