---
title: C and C++
description: C, C++ and Objective-C language features from clangd, with compile_commands.json, .clangd and .clang-tidy.
order: 13.5
---

The C and C++ server starts the first time you open a C, C++ or Objective-C file, such as `.c`, `.h`, `.cpp`, `.cc`, `.hpp`, `.m` or `.mm`, and stops when none remain open.

These files are served by [clangd](https://clangd.llvm.org). Besides diagnostics, hover, go-to-definition, references, rename and signature help, you get:

- **Semantic highlighting**: macros, namespaces, types and parameters are colored by what they are, and code disabled by `#if 0` is dimmed.
- **Inlay hints**: parameter names at call sites and deduced types, shown inline.
- **Quick fixes and refactorings** (`Cmd+.`): fix a typo clang recognizes, remove an unused include, replace `auto` with the deduced type, and more.
- **Project-wide search**: references, rename and Go to Symbol cover the whole project once clangd has indexed it in the background.

## Install clangd

Loxel uses the `clangd` on your shell's `PATH`, version 16 or newer:

- **macOS**: Xcode or its Command Line Tools include it (`xcode-select --install`).
- **Linux**: install your distribution's package, for example `sudo apt install clangd`, or `clangd-16` or newer where the default package is older.

If it was missing when you opened a file, the status bar says so; install it, then click that message to restart the server.

C and C++ language features are not available on Windows yet.

## Tell clangd how your code compiles

clangd needs your project's compile commands to find includes and apply your defines and language version. Without them it guesses, and the first errors you see are often missing headers.

The usual source is a `compile_commands.json` file. With CMake, turn it on when you configure:

```bash
cmake -S . -B build -DCMAKE_EXPORT_COMPILE_COMMANDS=ON
```

clangd looks for the file from each source file's folder upward, in each folder and its `build/` subfolder, so the `build` folder above is found without further setup, and each project in a monorepo can have its own. Other build systems have their own generators, such as `bear -- make` for Make.

For a small project, a `compile_flags.txt` file with one flag per line, at the project root, applies to every file:

```text
-std=c++20
-Iinclude
```

The index clangd builds is saved in `.cache/clangd/index/` beside `compile_commands.json`, and it ignores itself in git. If that folder is a symlink, clangd runs without the index, and references and rename cover only the open files.

## Configure clangd

A `.clangd` file in your project adds to or changes the compile flags and turns features on or off for the files under its folder:

```yaml
CompileFlags:
  Add: [-Wall, -std=c++20]
  Remove: [-march=*]
Diagnostics:
  UnusedIncludes: Strict
```

See clangd's [configuration reference](https://clangd.llvm.org/config) for every option. Your own config at `~/Library/Preferences/clangd/config.yaml` on macOS, or `~/.config/clangd/config.yaml` on Linux, applies to every project.

Loxel leaves out compile flags that make the compiler write output files, and flags that pass options through to it or load them from elsewhere: `-Xclang`, `-Xpreprocessor`, `-Wp,` and `--config`. This does not affect how your project builds, only what clangd sees.

## clang-tidy

A `.clang-tidy` file turns on [clang-tidy](https://clang.llvm.org/extra/clang-tidy/) checks, which appear as diagnostics while you edit, many with quick fixes. No separate install is needed:

```yaml
Checks: "bugprone-*,modernize-use-nullptr"
```

## Formatting

Formatting stays with [format on save](/docs/editor#formatter-auto-detection), which runs clang-format in projects with a `.clang-format` file.

---

## See also

- [Language Intelligence](/docs/language-intelligence) — the features every language server provides, and how servers start and stop per worktree
