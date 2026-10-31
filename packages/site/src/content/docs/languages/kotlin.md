---
title: Kotlin
description: Editing Kotlin files in Loxel, with raw strings, backtick identifiers, and KDoc comments.
order: 13.5
---

Kotlin source (`.kt`) and script (`.kts`) files get highlighting and 4-space indentation.

## Editing Kotlin files

- Typing `"""` adds the closing quotes, and typing the closing quotes steps over them.
- Backticks pair, so typing `` ` `` adds the closing one, and pressing it with text selected wraps the selection. Handy for identifiers such as test names.
- Typing `/**` adds the closing `*/`. Pressing Enter inside a KDoc comment continues it with a new `*` line.
- Pressing Enter after a lambda's parameters, as in `list.map { x ->`, indents the next line.
