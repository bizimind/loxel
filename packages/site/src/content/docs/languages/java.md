---
title: Java
description: Java language features from Eclipse JDT LS, running on your JDK 25 or newer, and the JDK Loxel uses for each worktree.
order: 13.5
---

The Java server starts the first time you open a `.java` file, and stops when none remain open. Loxel bundles [Eclipse JDT LS](https://github.com/eclipse-jdtls/eclipse.jdt.ls), and the server makes no network requests.

## Java 25 or newer

The server needs a JDK 25 or newer on your machine to run. If your project is on an older Java, install JDK 25 or newer alongside your project's JDK: the server runs on the newest one, and your code is still checked against the JDK of the worktree (see [JDK detection](#jdk-detection)). Without one, the Java server stops and the status bar says what to install. Installing a JDK while Loxel is open brings it back.

Maven and Gradle projects aren't loaded yet. The server starts with project import off, and what you get depends on the folder you open.

## Folders without a build file

Java files in a folder with no `pom.xml` or Gradle build get the full set of features for the code in that folder:

- Syntax and type errors as you type
- Hover, go-to-definition, go-to-implementation and references across files
- Rename across files, including renaming a class and its file
- Completion, including types you have not imported yet, `sysout`-style templates and argument placeholders
- Quick fixes and refactorings: add imports, organize imports, add unimplemented methods, generate getters and setters, surround with try/catch, extract to a variable, field or constant
- Document and workspace symbols, inlay hints for parameter names, folding and semantic highlighting
- **Format Document**

The source folder comes from the first Java file found in the folder, so a project with several source folders has one of them treated as source. `.jar` files under `lib/` are on the classpath.

## Maven and Gradle projects

In a folder with a build file, Java files are treated as separate files outside any project. They show a note saying so, and get:

- Syntax errors, but no type errors
- Completion, code actions, document symbols, references within the file, folding and semantic highlighting
- **Format Document**

Go-to-definition, rename, workspace symbols and hover on your own types need the project to be loaded, so they do not work there yet. Nothing from the build runs: not the build scripts, wrappers, plugins or annotation processors.

## JDK classes

Hover on a JDK class shows its documentation when the JDK includes its sources (`src.zip`), and only its signature otherwise. Most JDK distributions include them; some Linux packages put them in a separate package. Go-to-definition into JDK classes is not available yet.

## JDK detection

Each worktree has one JDK that Java features in Loxel use. Loxel uses the first of:

1. The JDK you chose for the worktree (see below).
2. `JAVA_HOME`, if it points to a JDK. If it does not, for example after the JDK it named was removed, Loxel ignores it and says so when you hover the status bar item.
3. The JDKs macOS knows about, as listed by `/usr/libexec/java_home -V`.
4. The JDK of the first `java` on your shell's `PATH`. The `/usr/bin/java` that macOS ships without a JDK does not count.
5. A JDK in a usual install location: `/Library/Java/JavaVirtualMachines`, `~/Library/Java/JavaVirtualMachines`, Homebrew's `openjdk` formulas, SDKMAN!, asdf, mise, `~/.jdks`, Gradle's `~/.gradle/jdks`, `/usr/lib/jvm`, and on Windows `Program Files\Java` and `Program Files\Eclipse Adoptium`.

When a step finds several JDKs, the newest wins.

A JRE does not count, since it cannot compile, and neither does a JDK committed to the repository. Loxel never downloads or installs a JDK, and it does not read version pins such as `.java-version` or `.sdkmanrc`. Installing or removing a JDK while Loxel is open is picked up automatically.

## Seeing and changing the JDK

While a Java file is the active editor, the status bar shows the worktree's JDK, for example `Java 21.0.5 (Temurin)`. Hover it to see the JDK's full path and how it was found. If there is none, it reads **No JDK found**.

Click it, or run **Java: Select JDK** from the command palette (`Cmd+Shift+P`), to choose another one:

- **Enter JDK path…** takes the home directory of a JDK, such as `~/.sdkman/candidates/java/21.0.5-tem`.
- **Use automatic detection** goes back to the order above.
- The rest of the list is every JDK Loxel found.

The choice is saved for that worktree and survives restarts. If the chosen JDK is later deleted, Loxel goes back to automatic detection and shows the status bar item in the warning color until you choose again.

---

## See also

- [Language Intelligence](/docs/language-intelligence) — the features every language server provides, and how servers start and stop per worktree
