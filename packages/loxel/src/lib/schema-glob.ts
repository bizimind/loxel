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
