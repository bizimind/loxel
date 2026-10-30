import { skipToken, useQuery } from "@tanstack/react-query";

import * as api from "@/api/client";
import { useActiveEditorFile } from "@/hooks/useActiveEditorFilePath";
import { resolveLanguage } from "@/lib/resolve-language";
import {
  rustToolchainLabel,
  rustToolchainTooltip,
  selectRustToolchain,
} from "@/lib/rust-toolchain";
import { cn } from "@/lib/utils";
import { queryKeys } from "@/queries/query-keys";
import { deriveProject, useProjectStore } from "@/store/projects";
import { selectEffectiveFileAssociations, useSettingsStore } from "@/store/settings-store";

/**
 * The Rust toolchain of the active editor's worktree (the panel's own, which is not always the
 * active worktree), shown while that editor holds a Rust file. Clicking it opens the toolchain
 * picker for that worktree.
 */
export function RustToolchainStatus() {
  const active = useActiveEditorFile();
  const associations = useSettingsStore(selectEffectiveFileAssociations);
  const isRust = active !== null && resolveLanguage(active.filePath, associations) === "rust";
  const wtPath = isRust ? active.worktreePath : null;
  const projectPath = useProjectStore((s) => deriveProject(wtPath, s.projects)?.path ?? null);
  const { data } = useQuery({
    queryKey: queryKeys.rustToolchain(projectPath, wtPath),
    queryFn: wtPath ? () => api.getRustToolchain(wtPath) : skipToken,
    staleTime: Infinity, // WebSocket bridge invalidates it on rust_toolchain_changed
  });

  if (!wtPath || !data) return null;

  const { toolchain, chosen } = data;
  const chosenUnusable =
    chosen !== null && (toolchain.status !== "active" || toolchain.source !== "chosen");
  const tooltip = [
    rustToolchainTooltip(toolchain),
    chosenUnusable && `The chosen toolchain ${chosen} cannot be used, so detection picked this one`,
    "Click to select a toolchain",
  ]
    .filter(Boolean)
    .join("\n");

  return (
    <button
      type="button"
      onClick={() => void selectRustToolchain(wtPath)}
      title={tooltip}
      className={cn(
        "hover:text-foreground flex cursor-pointer items-center gap-1 transition-colors",
        toolchain.status === "active" && !chosenUnusable ? "text-muted-foreground" : "text-warning",
      )}
    >
      {rustToolchainLabel(toolchain)}
    </button>
  );
}
