---
title: C and C++
description: C, C++ and Objective-C language features from clangd, with compile_commands.json in any build folder, .clangd and .clang-tidy.
order: 13.5
---

The C and C++ server starts the first time you open a C, C++ or Objective-C file, such as `.c`, `.h`, `.cpp`, `.cc`, `.hpp`, `.m` or `.mm`, and stops when none remain open.

These files are served by [clangd](https://clangd.llvm.org). Besides diagnostics, hover, go-to-definition, references, rename and signature help, you get:

- **Semantic highlighting**: macros, namespaces, types and parameters are colored by what they are, and code disabled by `#if 0` is dimmed.
- **Inlay hints**: parameter names at call sites and deduced types, shown inline.
- **Quick fixes and refactorings** (`Cmd+.`): fix a typo clang recognizes, remove an unused include, replace `auto` with the deduced type, and more.
- **Project-wide search**: references, rename and Go to Symbol cover the whole project once clangd has indexed it in the background.

## What you need to install

In a [trusted repository](/docs/repository-trust), Loxel uses the `clangd` on your shell's `PATH`, including Xcode's, so language features match the compiler you build with. It needs version 16 or newer; otherwise, Loxel uses its own where it has one.

On macOS, clangd also ships with Loxel, so these features work with nothing installed, and it is what runs until you trust the repository. In a repository you haven't trusted, Xcode's clangd isn't supported. Standard headers such as `<stdio.h>` and `<vector>` come from Apple's developer tools. If you don't have them, Loxel tells you, and `#include`s of those headers show as not found until you install them in a terminal:

```bash
xcode-select --install
```

Then run **Restart Language Servers** from the command palette. Loxel never installs them for you.

On Linux, Loxel uses the `clangd` on your shell's `PATH` in every repository, version 16 or newer. Install your distribution's package, for example `sudo apt install clangd`, or `clangd-16` or newer where the default package is older. If it was missing when you opened a file, the status bar says so; install it, then click that message to restart the server.

C and C++ language features are not available on Windows yet.

## Tell clangd how your code compiles

clangd needs your project's compile commands to find includes and apply your defines and language version. Without them it guesses, and the first errors you see are often missing headers.

The usual source is a `compile_commands.json` file. With CMake, turn it on when you configure:

```bash
cmake -S . -B build -DCMAKE_EXPORT_COMPILE_COMMANDS=ON
```

clangd looks for the file from each source file's folder upward, in each folder and its `build/` subfolder, so the `build` folder above is found without further setup, and each project in a monorepo can have its own. Other build systems have their own generators, such as `meson setup build` for Meson and `bear -- make` for Make. Loxel never runs these for you.

A project with its own compiler gets its include paths from that compiler once you [trust the repository](/docs/repository-trust), so cross-compilers work whatever they are called and wherever they are. Until then, clangd asks only compilers in system folders. Loxel doesn't always prompt for this, so run **Manage Repository Trust** from the command palette if your project needs it.

For a small project, a `compile_flags.txt` file with one flag per line, at the project root, applies to every file:

```text
-std=c++20
-Iinclude
```

The index clangd builds is saved in `.cache/clangd/index/` beside `compile_commands.json`, and it ignores itself in git. If that folder is a symlink, clangd skips the background index, and references and rename cover only the open files. The same goes, until you [trust the repository](/docs/repository-trust), for a repository whose `.clangd` names a compile database outside its worktree.

## Which compile database a file uses

While a C, C++ or Objective-C file is active, the status bar shows the compile database it uses, such as `C++ (cmake-build-debug)`. Hover it to see the path and how it was found.

| The status bar shows              | What it means                                                                                                                                                  |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `C++ (build)`                     | The folder holding the file's `compile_commands.json`                                                                                                          |
| `C++ (compile_commands.json)`     | The file itself, at the root of the worktree                                                                                                                   |
| `C++ (compile_flags.txt)`         | A flags file that applies to the files below it                                                                                                                |
| `C++ (.clangd flags)`             | No database, and a `.clangd` file adds compile flags                                                                                                           |
| `C++ (no compile database)`       | clangd guesses the flags, so includes may be missing. In yellow, the tooltip says what to run. Not in yellow, a `.clangd` file has `CompilationDatabase: None` |
| `C++ (choose a compile database)` | Loxel found some but can't tell which applies, and clangd is guessing until you pick one                                                                       |

Build folders with other names work too. clangd doesn't look in `cmake-build-debug/`, `build-debug/` or `out/build/x/`, so Loxel looks under the root of the worktree for `cmake-build-*`, `build-*`, `build/*`, `out/*` and `out/build/*`, and for any folder CMake, Ninja or Meson has configured. If there's exactly one with a `compile_commands.json`, Loxel uses it. If there are several, which applies is up to you, so it uses none and asks.

A compile database found this way applies to every file, so Loxel leaves it to you when clangd finds a database by itself anywhere in the worktree, such as a monorepo project's own `build/`. Those projects keep working as they are. In a very large worktree, which Loxel can't search whole, it leaves the choice to you as well.

Click the item, or run **C/C++: Select Compile Database** from the command palette (`Cmd+Shift+P`), to choose for this worktree:

- **Use automatic detection**: the rules above.
- **A folder Loxel found**: applies to every file of the worktree.
- **Enter a folder or compile database path**: any folder holding a `compile_commands.json` or `compile_flags.txt`, also outside the worktree. It applies to every file too, over a project's own database and a `.clangd` file's.

The language server restarts when the database in use changes, whether you chose it or a new build folder appeared, and your open files and unsaved edits stay as they are. The index goes beside the database, in its folder's `.cache/clangd/index/`.

## When files change on disk

Open files follow what happens on disk, whoever makes the change: a saved header, an edit from an agent or another editor, or a `git checkout`. Diagnostics update within a second. Unsaved edits to an open header reach other files once you save.

- **`compile_commands.json` and `compile_flags.txt`** apply within about 6 seconds of a change, and within about 31 seconds when the file is new, so you can run CMake in a terminal and keep working. Loxel never runs a build itself.
- **`.clangd` and `.clang-tidy`** apply within about 6 seconds.
- **References and Go to Symbol** catch up with files that aren't open about a minute after the changes stop, and at most every 5 minutes, when the server restarts itself. This takes a moment, and your open files and unsaved edits stay as they are.

## Configure clangd

A `.clangd` file in your project adds to or changes the compile flags and turns features on or off for the files under its folder. It can also name a compile database with `CompilationDatabase`, a folder relative to the `.clangd` file, or turn it off with `None`:

```yaml
CompileFlags:
  Add: [-Wall, -std=c++20]
  Remove: [-march=*]
Diagnostics:
  UnusedIncludes: Strict
```

See clangd's [configuration reference](https://clangd.llvm.org/config) for every option. Your own config at `~/Library/Preferences/clangd/config.yaml` on macOS, or `~/.config/clangd/config.yaml` on Linux, applies to every project.

In a repository you haven't trusted, Loxel leaves out compile flags that make the compiler write output files, and flags that pass options through to it or load them from elsewhere: `-Xpreprocessor`, `-Wp,` and `--config`. This does not affect how your project builds, only what clangd sees.

## clang-tidy

A `.clang-tidy` file turns on [clang-tidy](https://clang.llvm.org/extra/clang-tidy/) checks, which appear as diagnostics while you edit, many with quick fixes. No separate install is needed:

```yaml
Checks: "bugprone-*,modernize-use-nullptr"
```

## Formatting

[Format on save](/docs/editor#formatter-auto-detection) runs your own `clang-format` for C, C++ and Objective-C++ files. Loxel never installs it: when it's missing, a message says what to run, such as `brew install clang-format` on a Mac (Xcode doesn't include it).

A file is formatted when a `.clang-format` or `_clang-format` file sits in its folder or a parent folder inside the worktree, so each project in a monorepo can have its own, and `InheritParentConfig` works as usual. Without one, files are saved as they are rather than in clang-format's default style.

Files matched by the nearest `.clang-format-ignore` are saved unformatted, with clang-format's own rules for that file. If clang-format can't use a config, for example because of an unknown key, a message shows the error once and the file is saved as it is.

`.m` files aren't formatted automatically, since `.m` is also MATLAB; add a manual formatter for `m` in Settings if your project is Objective-C.

---

## See also

- [Language Intelligence](/docs/language-intelligence) — the features every language server provides, and how servers start and stop per worktree
- [Repository Trust](/docs/repository-trust) — how a language feature asks before running a repository's code
