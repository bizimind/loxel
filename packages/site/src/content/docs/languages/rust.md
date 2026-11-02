---
title: Rust
description: Language features through your own rust-analyzer, the toolchain of each worktree, the status bar item, the toolchain picker and format on save.
order: 13.5
---

Loxel gives Rust files language features through your own rust-analyzer. It works out which Rust toolchain each worktree uses, shows it while you edit a Rust file, and lets you choose another installed one. Each worktree has its own.

## Language features

Install rust-analyzer with `rustup component add rust-analyzer`, or any other way that puts it on your `PATH`, along with `rustup component add rust-src` for the standard library. Loxel never installs anything. If a part is missing, the status bar or a notification says what to run. Versions from before January 2025 aren't started.

Opening a `.rs` file starts the server for that worktree, which gives you hover, go to definition (including into the standard library and dependencies), references, rename across crates and of modules (from the definition; from a use in another crate, it adds a local alias instead), quick fixes, completion with auto-import, signature help, inlay hints, folding, symbols, and diagnostics as you type. To format Rust files, use [format on save](/docs/editor).

Language features run without building your project:

- **Build scripts and proc macros don't run**, so macros they generate aren't expanded and items that only exist after a build, such as `include!` of generated code, are unknown.
- **`cargo check` doesn't run**, so diagnostics are rust-analyzer's own and not the compiler's. **No marker doesn't mean no error.** You see syntax errors, wrong argument counts, missing struct fields, non-exhaustive matches and, in recent versions of rust-analyzer, mismatched types. Only `cargo check` in a terminal reports unknown names, types, methods, fields and macros, unimported items (the Import quick fix is still offered), unresolved `use` and `mod`, unmet trait bounds, and borrow checker errors such as use after move.
- **Nothing is downloaded.** Dependencies that aren't in your local Cargo cache are unknown until you run `cargo fetch` in a terminal and then **Restart Language Servers**.
- **Flags and cross targets in `.cargo/config.toml` don't apply to analysis**, which uses your compiler's own target. `rust-project.json` isn't read.

## Projects

Monorepos work. Opening a `.rs` file loads the project it belongs to, however deep it is in the worktree: the nearest `Cargo.toml` above it, or that crate's workspace. A crate excluded from a workspace, such as `fuzz/`, loads on its own. The first file of a new project can take a moment while it loads, and nothing restarts. If a `Cargo.toml` can't be read, a notification names the folder, and the project loads once you fix it.

The worktree's own `Cargo.toml`, or those one folder down when the root has none, load as soon as the server starts. Loxel adds up to 10 more projects as you open their files, and tells you when it reaches that. To free them, close the files you no longer need and run **Restart Language Servers**.

A `.rs` file with no `Cargo.toml` above it in the worktree still gets language features, on its own, at edition 2024, with the standard library. It can use modules next to it, but not dependencies, including those in a cargo script's header.

Files under `target` or `node_modules`, vendored crates and files outside the worktree don't load a project of their own. Files you reach with go to definition, such as the standard library, still work while the project that led there is loaded.

## Rust toolchain

Loxel looks for Rust on your shell's `PATH`, then in `$CARGO_HOME/bin`, then in `~/.cargo/bin`, and uses the `rustc` your shell would run. If that is a Rust installed without rustup, such as Homebrew's or a distribution's package, it is the worktree's toolchain and there is nothing to choose from.

With [rustup](https://rustup.rs), Loxel uses the first of:

1. The toolchain you chose for the worktree (see below).
2. The `RUSTUP_TOOLCHAIN` variable.
3. A `rustup override` for the worktree's folder.
4. A `rust-toolchain.toml` or `rust-toolchain` file in the worktree or a folder above it.
5. Your rustup default.

Loxel never downloads or installs a toolchain or component. If the project pins a toolchain you don't have, the status bar says so and tells you what to run; installing it is up to you, from a terminal.

Loxel uses toolchains from outside the worktree. If a toolchain file names one inside it, or one the repository contains, the status bar item shows this in the warning color, and you can choose an installed toolchain instead.

Loxel doesn't run version-manager shims, such as asdf's or mise's, or other script wrappers. Install Rust with rustup or a package to use it here.

Editing the worktree's toolchain file, installing or removing a toolchain or component, or changing your rustup default while Loxel is open is picked up automatically.

## Seeing and changing the toolchain

While a Rust file is the active editor, the status bar shows the worktree's toolchain, for example `Rust 1.99.1 (stable)`. Hover it to see the compiler's full path and how the toolchain was found.

The item uses the warning color when something needs you:

- **The pinned toolchain isn't installed.** The tooltip gives the command to run, such as `rustup toolchain install 1.90.0`.
- **No toolchain was found.** The tooltip says how to install Rust, or, when you have rustup, to run `rustup default stable`.
- **Your rustup is too old.** Versions before 1.28 can install toolchains on their own, so Loxel doesn't run them. The tooltip tells you to run `rustup self update`.
- **rustup reports a problem**, such as a toolchain file it can't read. The tooltip shows what it said.

Click the item, or run **Rust: Select Toolchain** from the command palette (`Cmd+Shift+P`), to choose another one:

- **Use automatic detection** goes back to the order above.
- The rest of the list is every toolchain you have installed with rustup. Without rustup there is nothing else to choose.

The language server follows the toolchain, restarting when it changes. The choice is saved for that worktree and survives restarts, and it takes precedence over a toolchain file. It doesn't change what `cargo` runs in your own terminals. If the chosen toolchain is later removed, Loxel goes back to automatic detection and shows the status bar item in the warning color until you choose again.

## Format on save

A `.rs` file is formatted with `rustfmt` on save when it has a `Cargo.toml` in its folder or a folder above it, up to the worktree's root, or a `rustfmt.toml` or `.rustfmt.toml` there. The result matches `cargo fmt`:

- **Edition.** The edition comes from the nearest `Cargo.toml`, or from `[workspace.package]` when the crate has `edition.workspace = true`. A package that names none is edition 2015, as in Cargo. As with `cargo fmt`, this also beats an `edition` set in your `rustfmt.toml`. A file with only a `rustfmt.toml` uses the edition set there. While a `Cargo.toml` can't be read, files under it are saved as they are.
- **Config.** The nearest `rustfmt.toml` or `.rustfmt.toml` applies, so a crate can have its own. A config in a folder whose name has a space in it isn't supported, and a notice tells you when a save skips formatting because of that.
- **Which rustfmt.** It's the one from the worktree's [toolchain](#rust-toolchain), including one you chose. A file with a syntax error is saved as it is, without a message.

Formatting never installs anything. A notice tells you what to run when the save goes out unformatted because something is missing: `rustup component add rustfmt` for a toolchain without rustfmt, `rustup toolchain install` for a pinned toolchain you don't have, and how to install Rust when there is none.

To run something else, add a manual override in **Settings > Editor**. An override that runs `rustfmt` by name still uses the worktree's toolchain, so give a full path for a different one.

---

## See also

- [Language Intelligence](/docs/language-intelligence) — the features language servers provide, and how servers start and stop per worktree
- [Repository Trust](/docs/repository-trust) — how a language feature asks before running a repository's code
