# Kotlin

Kotlin (`.kt`, `.kts`) has no language server module yet. Shared language-server architecture: [LANGUAGE_SERVERS.md](../LANGUAGE_SERVERS.md).

## Editing behavior

[kotlin-language-config.ts](../../src/lib/kotlin-language-config.ts) re-registers Monaco's Kotlin `conf` after the built-in registration, in the same order as Python's (see [Highlighting and language resolution](../LANGUAGE_SERVERS.md#highlighting-and-language-resolution)), with raw string and backtick pairs, `notIn` conditions on the quote pairs, and on-enter rules for KDoc and lambdas with parameters. `kotlin-language-config.test.ts` exercises it under the Shiki tokenizer the app uses, since `notIn` reads token types.
