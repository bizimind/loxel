---
title: Java
description: Java language features from Eclipse JDT LS, running on your JDK 25 or newer, Maven and Gradle projects in trusted repositories, format on save, and the JDK Loxel uses for each worktree.
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

## Format on save

Saving a Java file formats it with [google-java-format](https://github.com/google/google-java-format) or [palantir-java-format](https://github.com/palantir/palantir-java-format), when the project declares one. A project that declares neither isn't formatted on save. See [Formatter auto-detection](/docs/editor#formatter-auto-detection) for when format on save runs.

Loxel looks in the file's folder and up to the root of the worktree, so each module in a monorepo can use its own. It reads these files and never runs your build:

- **Spotless:** `googleJavaFormat` or `palantirJavaFormat` in `pom.xml`, `build.gradle` or `build.gradle.kts`, with the options you set there, such as AOSP style.
- **fmt-maven-plugin:** from `com.spotify.fmt` or `com.coveo`, in `pom.xml`.
- **Palantir's Gradle plugin:** `com.palantir.java-format`.

Spotless configured only with other formatters, such as `eclipse()`, or only with steps such as `removeUnusedImports`, doesn't turn this on. Neither does configuration Loxel can't see without running the build: in a convention plugin, a separate Gradle script, or a parent POM that isn't in a folder above the file.

Loxel uses a formatter you already have, and never downloads one. When your project pins a version, only that version runs, because another one could reformat code you didn't touch:

1. The tool on your `PATH`, if its version matches, or any version if the project pins none.
2. For google-java-format, the pinned version from your Maven or Gradle cache, there once Spotless has run for the project, on a JDK that can run it.

Otherwise the file is saved unformatted, and a notice says which version the project wants. A project whose Spotless config uses `toggleOffOn`, or a version or option Loxel can't read from its build files, also gets a notice instead of being formatted. Version managers' shims aren't used, so add the tool's own directory to your `PATH`. Files with syntax errors are saved as they are.

**Format Document** uses the language server's own formatter, which doesn't follow these settings.

## JDK classes

Hover on a JDK class shows its documentation when the JDK includes its sources (`src.zip`), and only its signature otherwise. Most JDK distributions include them; some Linux packages put them in a separate package. Go-to-definition into JDK classes is not available yet.

## JDK detection

Each worktree has one JDK that Java features in Loxel use, and so do [Kotlin's ktlint and detekt](/docs/languages/kotlin#jdk). Loxel uses the first of:

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
