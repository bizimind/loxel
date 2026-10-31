---
title: TOML
description: TOML language features from Tombi, with syntax and schema checks, completions and hover from JSON Schemas.
order: 13.5
---

The TOML server starts the first time you open a `.toml` file, `Pipfile`, `Cargo.lock`, `.cargo/config`, `poetry.lock` or `uv.lock`, and stops when none remain open.

TOML files are checked by [Tombi](https://tombi-toml.github.io/tombi/). It underlines syntax errors and values that do not match the file's JSON Schema, and the schema also drives completions and hover documentation for keys and values. You also get the document outline, folding, go-to-definition and quick fixes.

Schemas come from **Settings > Schemas**, the same mappings JSON and YAML files use. These files have built-in schemas from [SchemaStore](https://www.schemastore.org):

- `pyproject.toml`, including tool tables such as `[tool.ruff]` and `[tool.uv]`
- `Cargo.toml` and `.cargo/config.toml`
- `rust-toolchain.toml`
- `ruff.toml` and `.ruff.toml`
- `uv.toml`
- `rustfmt.toml` and `.rustfmt.toml`

Turn a built-in schema off to stop checking files against it, or add your own mapping: a glob ending in `.toml` and the schema's URL or local path. Your mappings take precedence over the built-in ones for the same file. A TOML glob with wildcards, such as `config/*.toml`, applies only to files inside the project, and its `*` also matches files in subfolders. Schemas are downloaded when a file first needs them and cached for a day.

A `#:schema` comment at the top of a file picks its schema directly, by URL or by a path relative to the file, and takes precedence over the settings:

```toml
#:schema ./schemas/app.schema.json
name = "demo"
```

Projects that configure Tombi themselves, with a `tombi.toml` or `.tombi.toml` file or a `[tool.tombi]` table in `pyproject.toml`, use that configuration instead of the Schemas settings, so the editor agrees with the `tombi` command line. A `~/.config/tombi/config.toml` of your own does the same for every project. Formatting stays with [format on save](/docs/editor#formatter-auto-detection).

---

## See also

- [Language Intelligence](/docs/language-intelligence) — the features every language server provides, and how servers start and stop per worktree
