# Rust

Shared language-server architecture: [LANGUAGE_SERVERS.md](../LANGUAGE_SERVERS.md).

## Editing behavior

[rust-language-config.ts](../../src/lib/rust-language-config.ts) re-registers Monaco's Rust `conf` after the built-in registration, in the same order as Python's (see [Highlighting and language resolution](../LANGUAGE_SERVERS.md#highlighting-and-language-resolution)). `rust-language-config.test.ts` checks that order and the resulting editing behavior.

- **On-enter rules** continue `///`, `//!`, `/** */` and `/*! */`. A `*` line continues only when its star sits one space past an even indent and the line above is part of the comment, which keeps rustfmt's `    * factor` lines out.
- **Auto-closing pairs** add `/**`, `/*!` and backticks. `'` is left out because it starts lifetimes. The block comment pairs use `notIn: ["string"]` only: Monaco checks the token before the cursor, which after `/*` is already a comment.
- **Folding markers** are `// region` and `// endregion`, replacing the C `#pragma region` markers in Monaco's `conf`.
- **A keydown hook** makes the `/` that ends an auto-closed block doc comment replace the inserted ` */`, since Monaco overtypes only the first character of a multi-character pair. It skips string tokens, where nothing was auto-closed, and tracks comment nesting on the line, so closing a plain comment inside a doc comment keeps the outer close.

## File recognition

`.cargo/config`, Cargo's older config name, resolves to TOML through a glob association in [settings-store.ts](../../src/store/settings-store.ts), since `config` alone says nothing about the format. A bare `rust-toolchain` stays plain text because its legacy format, a single channel name, is not TOML.
