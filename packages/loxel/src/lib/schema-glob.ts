/** The languages a schema mapping from Settings > Schemas can apply to. */
export type SchemaLanguage = "json" | "yaml" | "toml";

const LANGUAGE_OF_EXTENSION: Record<string, SchemaLanguage> = {
  json: "json",
  jsonc: "json",
  yml: "yaml",
  yaml: "yaml",
  toml: "toml",
};

/**
 * The languages whose files a schema glob targets, judged by the extension it ends with
 * (`**\/*.json`, `.github/workflows/*.{yml,yaml}`, `**\/pyproject.toml`). A glob without a known
 * extension (`**\/*`, `**\/Pipfile`, `**\/Cargo.lock`) applies to every language.
 */
export function classifySchemaGlob(glob: string): Record<SchemaLanguage, boolean> {
  const extensions: string[] = [];
  const braceMatch = /\.\{([^}]+)\}$/.exec(glob);
  if (braceMatch) {
    for (const ext of braceMatch[1]!.split(",")) extensions.push(ext.trim());
  } else {
    const simpleMatch = /\.(\w+)$/.exec(glob);
    if (simpleMatch) extensions.push(simpleMatch[1]!);
  }

  const languages = new Set(
    extensions.flatMap((ext) => LANGUAGE_OF_EXTENSION[ext.toLowerCase()] ?? []),
  );
  if (languages.size === 0) return { json: true, yaml: true, toml: true };
  return { json: languages.has("json"), yaml: languages.has("yaml"), toml: languages.has("toml") };
}

/** The files a schema mapping applies to: those `glob` matches, less those `exclude` matches. */
export interface SchemaFileMatch {
  glob: string;
  /** One glob, without the `!`; empty or absent for none. */
  exclude?: string;
}

/** The exclusion glob of a mapping, or null for none. A leading `!` the user typed is dropped. */
export function schemaExcludeGlob({ exclude }: SchemaFileMatch): string | null {
  // Persisted settings are not validated, so a hand-edited value may be anything.
  const glob = typeof exclude === "string" ? exclude.trim().replace(/^!+/, "") : "";
  return glob ? glob : null;
}

/**
 * A mapping's patterns for Monaco's JSON `fileMatch` and yaml-language-server's `yaml.schemas`,
 * where a leading `!` excludes. Tombi has no exclusions, so TOML gets only `glob`.
 */
export function schemaFilePatterns(match: SchemaFileMatch): string[] {
  const exclude = schemaExcludeGlob(match);
  return exclude ? [match.glob, `!${exclude}`] : [match.glob];
}
