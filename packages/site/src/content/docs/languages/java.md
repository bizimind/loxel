---
title: Java
description: Java language features from Eclipse JDT LS, running on your JDK 25 or newer, Maven and Gradle projects in trusted repositories, Checkstyle diagnostics, and the JDK Loxel uses for each worktree.
order: 13.5
---

The Java server starts the first time you open a `.java` file, and stops when none remain open. Loxel bundles [Eclipse JDT LS](https://github.com/eclipse-jdtls/eclipse.jdt.ls), and it works from what is already on your machine: neither it nor Gradle downloads anything to load a project, even in a trusted repository.

## Java 25 or newer

The server needs a JDK 25 or newer on your machine to run. If your project is on an older Java, install JDK 25 or newer alongside your project's JDK: the server runs on the newest one, and your code is still checked against the JDK of the worktree (see [JDK detection](#jdk-detection)). Without one, the Java server stops and the status bar says what to install. Installing a JDK while Loxel is open brings it back.

What you get depends on the folder a file is in, and on whether you [trust the repository](/docs/repository-trust).

## Folders without a build file

Java files with no `pom.xml` or Gradle build in their folder or above it get the full set of features for the code in that folder:

- Syntax and type errors as you type
- Hover, go-to-definition, go-to-implementation and references across files
- Rename across files, including renaming a class and its file
- Completion, including types you have not imported yet, `sysout`-style templates and argument placeholders
- Quick fixes and refactorings: add imports, organize imports, add unimplemented methods, generate getters and setters, surround with try/catch, extract to a variable, field or constant
- Document and workspace symbols, inlay hints for parameter names, folding and semantic highlighting
- **Format Document**

The source folder comes from the first Java file found in the folder, so a project with several source folders has one of them treated as source. `.jar` files under `lib/` are on the classpath.

## Maven and Gradle projects

Maven and Gradle projects load once you trust the repository, which runs their build logic: Gradle build scripts, annotation processors and Maven plugins. A file in a loaded project gets everything above, across all the modules of the project and with its dependencies on the classpath. Projects in subfolders of a repository load too, and changes to build files are picked up as you save them or switch branches.

Until you trust the repository, a Java file with a `pom.xml` or Gradle build in its folder or a folder above it is treated as a separate file outside any project, and nothing from the build runs. It gets:

- Syntax errors, but no type errors
- Completion, code actions, document symbols, references within the file, folding and semantic highlighting
- **Format Document**

### What needs to be on your machine

Trusting a repository doesn't let Loxel download anything. Dependencies and Gradle itself need to be there already, which they are once you have built the project in a terminal. When something is missing, the status bar shows **Project not fully loaded** while a Java file is active. Hover it to see what is missing and what to run, and click it to load the projects again once you have.

| What you see                           | What to do                                                          |
| -------------------------------------- | ------------------------------------------------------------------- |
| A Gradle version isn't installed       | Run `./gradlew` once in a terminal                                  |
| A Gradle project with no wrapper       | Install Gradle, or add a wrapper                                    |
| Missing Maven or Gradle dependencies   | Run `mvn test-compile` or `./gradlew testClasses`                   |
| A Gradle version can't run on your JDK | Choose a JDK it supports, see [below](#seeing-and-changing-the-jdk) |

Projects with a Gradle toolchain find the JDKs Loxel knows about, and Gradle never downloads one.

### While a project loads

The first load of a large Gradle project can take a minute or two. Until it finishes, files show few or no errors, and go-to-definition and rename may find nothing.

### What it leaves behind

Loading a project writes what a build would: `target/` for Maven, and `bin/` and `.gradle/` for Gradle. Gradle's `bin/` isn't in every project's `.gitignore`, so you may want to add it. IDE files such as `.project` and `.classpath` are kept out of your project.

Each worktree runs its own Gradle process while its Java server does, about 500 MB or more on top of the server's 1 GB or so, and it stops with the server. Gradle processes you started yourself are not touched.

### Limits

- In a repository with Maven or Gradle projects, Java files outside any of them get syntax errors only.
- Projects whose tests use a different Java level from their main code may show false errors in tests.
- Kotlin sources and classes generated by other tools aren't visible to Java files in mixed projects.
- Of several Maven modules with the same `artifactId`, only the first loads.

## Checkstyle

If your build runs [Checkstyle](https://checkstyle.org), its findings appear in the editor next to the compiler's, marked `checkstyle`, with the build's severity, the check's name and a link to its documentation. Checkstyle runs in trusted repositories, on your own `checkstyle` from your `PATH`. Run `brew install checkstyle`, or use another install method from its site. If it's missing, Loxel tells you once. Loxel never downloads it.

A file is checked when you open it and each time it changes on disk, so unsaved edits aren't checked. Nothing is written to your project.

### What counts as using Checkstyle

A build counts when it names Checkstyle itself. A config file nothing refers to doesn't turn it on.

- **Maven:** `maven-checkstyle-plugin` applied in a `pom.xml` or a parent above it, or configured with a `configLocation` under `pluginManagement`. Loxel reads `configLocation`, `suppressionsLocation`, `propertyExpansion`, `propertiesLocation`, `includeTestSourceDirectory`, `sourceDirectories`, `includes`, `excludes` and `skip`. Test code is checked only if `includeTestSourceDirectory` says so, as with the plugin.
- **Gradle:** the `checkstyle` plugin in a build script, in a parent's `subprojects` or `allprojects`, in `buildSrc` or `build-logic`, or in a script applied with `apply from:`. Loxel reads `configFile`, `configDirectory`, `configProperties`, `sourceSets` and each task's `exclude` and `include`, and uses `config/checkstyle/checkstyle.xml` at the root project by default.

Each file belongs to the nearest build file above it, so subprojects with their own config get their own. Loxel reads builds as text and never runs them, so settings it can't see in that text, such as a value computed by a script, aren't applied.

### When a config doesn't load

A config can fail in the version of Checkstyle you have, for example one that names a check a newer release removed, a custom check that isn't on Checkstyle's classpath, or a property only the build can work out. Loxel then shows Checkstyle's own message once, with the version your project pins if it can tell, and shows no Checkstyle findings for that project until a config or build file changes.

Loxel runs the `checkstyle` you have, whichever version your build pins. A different version can report different findings than your build does. Custom checks don't load, and a config's URLs and `cacheFile` aren't used: Loxel doesn't fetch what a config names, and a config that needs that doesn't load.

## JDK classes

Hover on a JDK class shows its documentation when the JDK includes its sources (`src.zip`), and only its signature otherwise. Most JDK distributions include them; some Linux packages put them in a separate package. Go-to-definition into JDK classes is not available yet.

## JDK detection

Each worktree has one JDK that Java features in Loxel use, and so do [Kotlin's ktlint and detekt](/docs/languages/kotlin#jdk). [Checkstyle](#checkstyle) is the exception: it runs on the newest JDK Loxel finds, since recent releases need a recent Java and every release runs on one. Loxel uses the first of:

1. The JDK you chose for the worktree (see below).
2. `JAVA_HOME`, if it points to a JDK. If it does not, for example after the JDK it named was removed, Loxel ignores it and says so when you hover the status bar item.
3. The JDKs macOS knows about, as listed by `/usr/libexec/java_home -V`.
4. The JDK of the first `java` on your shell's `PATH`. The `/usr/bin/java` that macOS ships without a JDK does not count.
5. A JDK in a usual install location: `/Library/Java/JavaVirtualMachines`, `~/Library/Java/JavaVirtualMachines`, Homebrew's `openjdk` formulas, SDKMAN!, asdf, mise, `~/.jdks`, Gradle's `~/.gradle/jdks`, `/usr/lib/jvm`, and on Windows `Program Files\Java` and `Program Files\Eclipse Adoptium`.

When a step finds several JDKs, the newest wins.

A JRE does not count, since it cannot compile, and neither does a JDK committed to the repository. Loxel never downloads or installs a JDK, and it does not read version pins such as `.java-version` or `.sdkmanrc`. Installing or removing a JDK while Loxel is open is picked up automatically.

## Seeing and changing the JDK

While a Java or Kotlin file is the active editor, the status bar shows the worktree's JDK, for example `Java 21.0.5 (Temurin)`. Hover it to see the JDK's full path and how it was found. If there is none, it reads **No JDK found**.

Click it, or run **Java: Select JDK** from the command palette (`Cmd+Shift+P`), to choose another one:

- **Enter JDK path…** takes the home directory of a JDK, such as `~/.sdkman/candidates/java/21.0.5-tem`.
- **Use automatic detection** goes back to the order above.
- The rest of the list is every JDK Loxel found.

The choice is saved for that worktree and survives restarts. If the chosen JDK is later deleted, Loxel goes back to automatic detection and shows the status bar item in the warning color until you choose again.

New terminals in that worktree start with the chosen JDK, see [Java JDK in terminals](/docs/terminals#java-jdk). Automatic detection leaves terminals as they are.

---

## See also

- [Language Intelligence](/docs/language-intelligence) — the features every language server provides, and how servers start and stop per worktree
- [Repository Trust](/docs/repository-trust) — how a language feature asks before running a repository's code
