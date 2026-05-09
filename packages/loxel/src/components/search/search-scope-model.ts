export type SearchScopePreset = {
  type: "preset";
  id: "all" | "worktree" | "drafts" | "ignored";
  label: string;
};

export type WorkspacePackage = { name: string; relativePath: string };

export type SearchScopePackage = { type: "package" } & WorkspacePackage;

export type SearchScopeCustom = { type: "custom"; relativePath: string };

export type SearchScopeExtension = { type: "extension"; ext: string };

export type SearchScope =
  | SearchScopePreset
  | SearchScopePackage
  | SearchScopeCustom
  | SearchScopeExtension;

export const SEARCH_PRESETS: SearchScopePreset[] = [
  { type: "preset", id: "all", label: "All Files" },
  { type: "preset", id: "worktree", label: "Worktree Files" },
  { type: "preset", id: "drafts", label: "Draft Files" },
  { type: "preset", id: "ignored", label: "Ignored Files" },
];

/** Stable string key for a scope, used for equality checks and effect deps. */
export function scopeKey(scope: SearchScope): string {
  switch (scope.type) {
    case "preset":
      return `preset:${scope.id}`;
    case "package":
      return `pkg:${scope.relativePath}`;
    case "custom":
      return `custom:${scope.relativePath}`;
    case "extension":
      return `ext:${scope.ext}`;
    default: {
      const _exhaustive: never = scope;
      throw new Error(`Unknown SearchScope type: ${String(_exhaustive)}`);
    }
  }
}

/** Derive API parameters from the current scope selection. */
export function deriveScopeParams(scopes: SearchScope[]): {
  scope?: "all" | "worktree" | "drafts" | "ignored";
  paths?: string[];
  globs?: string[];
} {
  if (scopes.length === 0) return {};

  const preset = scopes.find((s) => s.type === "preset");
  const paths = scopes
    .map((s) => {
      if (s.type === "package" || s.type === "custom") return s.relativePath;
      return "";
    })
    .filter(Boolean);
  const globs = scopes
    .filter((s): s is SearchScopeExtension => s.type === "extension")
    .map((s) => `*.${s.ext}`);

  if (preset) {
    return {
      ...(preset.id === "all" ? {} : { scope: preset.id }),
      ...(globs.length > 0 ? { globs } : {}),
    };
  }

  return { ...(paths.length > 0 ? { paths } : {}), ...(globs.length > 0 ? { globs } : {}) };
}
