# Java

Java files are served by Eclipse JDT LS (jdtls), which Loxel bundles with its own Java runtime. Shared language-server architecture: [LANGUAGE_SERVERS.md](../LANGUAGE_SERVERS.md).

## Manager

| Manager                                                     | Binary                   | Args                  | Scope    | Flags and config                                                                                                                             |
| ----------------------------------------------------------- | ------------------------ | --------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| [java-lsp-manager.ts](../../src/server/java-lsp-manager.ts) | `jdtls-runtime/bin/java` | `jdtlsArgs`, no shell | worktree | watched files; settings at `initialize` and pushed after `initialized`; per-file indentation pulled; drops `willRename` and two code actions |

## Binary

Two manifests, so the choice of bundling stays in them, their scripts and `resolveBundledJdtls`:

- [download-jdtls.ts](../../scripts/download-jdtls.ts) fetches the jdtls release, one archive for every platform, unmodified apart from an added `LICENSE` and `NOTICE` at its top level.
- [build-jdtls-runtime.ts](../../scripts/build-jdtls-runtime.ts) downloads the Temurin JDK of the build machine's platform and runs jlink. Temurin has no `jmods/`, so jlink links from the JDK's own image and cannot build for another platform; each release runner builds its own. jdtls needs Java 25, although `bin/jdtls.py` says 21: on 21 the JVM exits with code 13 without answering `initialize`, and the reason is only in a log. The module list is the smallest that starts; without `java.desktop` bundles fail to resolve `java.beans`.

Temurin's Mach-O files keep their signatures through jlink. A release signs them again with `hardenedRuntime`, and child binaries get electron-builder's default entitlements, which allow the JIT. The update archive's `sign` step signs `java` and `jspawnhelper` ad hoc. Both directories are in `UPDATE_RESOURCE_DIRS`, since stale jars next to new ones would break the server.

## Starting the server

The runtime's `java` runs directly, with `-jar` on the launcher. There is no PATH fallback: this server runs only on its own runtime.

- `-configuration` is writable, in `<state>/jdtls/configuration/<core plugin file name>`, because the signed app is not. `osgi.sharedConfiguration.area` points read-only at the bundled `config_<platform>`.
- `-data` is per worktree path, `<state>/jdtls/data/<hash>`, since two same-named projects in one directory collide. It is deleted when the worktree is removed, in Loxel or from outside it, or when the server exits if it was still running then. A moved worktree starts a new one. A new server waits for the previous one on its worktree to exit first, since the directory takes one server at a time, and the JVM's working directory is this directory rather than the worktree.
- `serverFailureReason` reports the last `!MESSAGE` of the newest log written since the server started in the configuration directory, which is the only place a JVM that cannot start explains why.
- `-Xmx1G` with `ParallelGC` tuned to return memory. Resident memory is about 700 MB on a project of 300 files, most of it not heap: a cap of 256 MB still leaves 544 MB and starts slower.

## Project import off

The server starts with project import off and makes no network requests.

- `java.import.maven.enabled` and `java.import.gradle.enabled` are false, `java.import.exclusions` is `["**"]` and `java.autobuild.enabled` is false. Each session gets them in `initializationOptions`, because jdtls reads those before its first import, and again through `workspace/didChangeConfiguration`. `notifyConfigurationChanged` sends `settings: null`, which jdtls ignores.
- `-Djava.import.generatesMetadataFilesAtProjectRoot=false` is a JVM property, not a setting; as a setting it does nothing.
- `-Djdk.net.hosts.file` points at a file naming only `localhost`.
- [audit-jdtls.ts](../../scripts/network-audit/audit-jdtls.ts) checks all of this through the built `loxel-server`, on opening files and on every command a user can reach, with `--control` as its positive control. Run it after changing the pin, the runtime or the manager.

Each folder gets one invisible project. jdtls infers its source root from the first Java file it hears about, and `initialize` comes before any file opens, so `firstJavaFile`, a pruned walk that runs while the session's frames are held, passes one as `triggerFiles`. A folder with a build file stays outside any project, and its files report "non-project file, only syntax errors are reported".

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
