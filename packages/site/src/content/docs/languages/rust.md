---
title: Rust
description: The Rust toolchain of each worktree, the status bar item and the toolchain picker.
order: 13.5
---

Loxel works out which Rust toolchain each worktree uses, shows it while you edit a Rust file, and lets you choose another installed one. Each worktree has its own.

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

The choice is saved for that worktree and survives restarts, and it takes precedence over a toolchain file. It doesn't change what `cargo` runs in your own terminals. If the chosen toolchain is later removed, Loxel goes back to automatic detection and shows the status bar item in the warning color until you choose again.

---

## See also

- [Language Intelligence](/docs/language-intelligence) — the features language servers provide, and how servers start and stop per worktree
