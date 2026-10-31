---
title: Java
description: Java language features from Eclipse JDT LS, bundled with its own Java runtime, so no JDK is needed.
order: 13.5
---

The Java server starts the first time you open a `.java` file, and stops when none remain open. Loxel bundles [Eclipse JDT LS](https://github.com/eclipse-jdtls/eclipse.jdt.ls) and the Java runtime it needs, so you do not need a JDK installed. The server makes no network requests.

Maven and Gradle projects are not loaded yet. The server starts with project import off, and what you get depends on the folder you open.

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

Hover on a JDK class shows its signature, without Javadoc. Go-to-definition into JDK classes is not available yet.

---

## See also

- [Language Intelligence](/docs/language-intelligence) — the features every language server provides, and how servers start and stop per worktree
