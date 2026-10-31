---
title: Java
description: The JDK Loxel uses for each worktree, how it is found, and how to choose another.
order: 13.5
---

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
- [Repository Trust](/docs/repository-trust) — how a language feature asks before running a repository's code
