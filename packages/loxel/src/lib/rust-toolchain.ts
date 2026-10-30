import * as api from "@/api/client";
import type {
  RustToolchain,
  RustToolchainChoice,
  RustToolchainResponse,
  RustToolchainSource,
} from "@/api/rust-toolchain-model";
import { showToast } from "@/components/ui/toast";
import { queryKeys } from "@/queries/query-keys";
import { queryClient } from "@/query-client";
import { type QuickPickItem, requestQuickPick } from "@/store/command-palette";
import { deriveProject, useProjectStore } from "@/store/projects";

import { abbreviateHomePath } from "./home-path";

// A picker id that cannot collide with a toolchain name, which rustup refuses with a `#`.
const AUTOMATIC_ID = "#automatic";

const SOURCE_DESCRIPTIONS: Record<RustToolchainSource, string> = {
  chosen: "Chosen for this worktree",
  "toolchain-file": "Selected by a toolchain file",
  environment: "Selected by RUSTUP_TOOLCHAIN in the environment",
  "directory-override": "Selected by a rustup directory override",
  default: "The rustup default",
  "no-rustup": "Installed without rustup, found on the login-shell PATH",
  unknown: "Selected by rustup",
};

/** A toolchain's name without its host triple: `stable-aarch64-apple-darwin` is `stable`. */
export function rustToolchainShortName(name: string): string {
  const withoutHost = name.replace(/-[a-z0-9_]+-(?:apple|pc|unknown)-[a-z0-9_-]+$/, "");
  return withoutHost.split("/").findLast(Boolean) ?? withoutHost;
}

function versionLabel(version: string | null, name: string | null): string {
  const short = name && rustToolchainShortName(name);
  const base = version ? `Rust ${version}` : "Rust";
  return short && short !== version ? `${base} (${short})` : base;
}

/** The toolchain as shown in the status bar, e.g. `Rust 1.99.1 (stable)`. */
export function rustToolchainLabel(toolchain: RustToolchain): string {
  if (toolchain.status === "active") return versionLabel(toolchain.version, toolchain.name);
  if (toolchain.status === "none") return "Rust: no toolchain";
  const short = rustToolchainShortName(toolchain.name);
  return toolchain.status === "not-installed"
    ? `Rust ${short} (not installed)`
    : `Rust ${short} (not run)`;
}

/** How the toolchain was found, or what is wrong and what to run, for the status bar's tooltip. */
export function rustToolchainTooltip(toolchain: RustToolchain): string {
  if (toolchain.status === "none") {
    return [
      // A detail is what is wrong, such as a broken toolchain file that a default would not fix.
      toolchain.detail ??
        (toolchain.rustupPath
          ? "No Rust toolchain is active. To install one, run `rustup default stable` in a terminal"
          : "Rust was not found. To install it, see https://rustup.rs"),
    ].join("\n");
  }
  const selectedBy = toolchain.toolchainFile ? `Selected by ${toolchain.toolchainFile}` : null;
  if (toolchain.status === "refused") {
    return [
      `The repository tracks ${toolchain.rustcPath} in git, so Loxel does not run it`,
      ...(selectedBy ? [selectedBy] : []),
    ].join("\n");
  }
  const why = selectedBy ?? SOURCE_DESCRIPTIONS[toolchain.source];
  if (toolchain.status === "active") return `${toolchain.rustcPath}\n${why}`;
  const short = rustToolchainShortName(toolchain.name);
  return [
    `${short} is not installed`,
    why,
    `To install it, run \`rustup toolchain install ${short}\` in a terminal`,
  ].join("\n");
}

function choiceItem(choice: RustToolchainChoice, chosen: string | null, home: string | null) {
  return {
    id: choice.name,
    label: versionLabel(choice.version, choice.name),
    description: abbreviateHomePath(choice.path, home),
    current: choice.name === chosen,
  };
}

/**
 * Let the user choose worktree `wtPath`'s Rust toolchain in the command palette: an installed one,
 * or automatic detection. The choice is saved per worktree on the server. Installing a toolchain
 * is left to the user's terminal.
 */
export async function selectRustToolchain(wtPath: string): Promise<void> {
  const { homeDir } = useProjectStore.getState();
  const items = api.getRustToolchainCandidates(wtPath).then(({ candidates, automatic, chosen }) => {
    const list: QuickPickItem[] = [
      {
        id: AUTOMATIC_ID,
        label: "Use automatic detection",
        description: rustToolchainLabel(automatic),
        current: chosen === null,
      },
      ...candidates.map((choice) => choiceItem(choice, chosen, homeDir)),
    ];
    return list;
  });

  const picked = await requestQuickPick({ placeholder: "Select a Rust toolchain", items });
  if (picked === null) return;

  try {
    const toolchain = picked === AUTOMATIC_ID ? null : picked;
    const response: RustToolchainResponse = await api.setRustToolchainChoice({
      worktreePath: wtPath,
      toolchain,
    });
    const projectPath = deriveProject(wtPath, useProjectStore.getState().projects)?.path ?? null;
    queryClient.setQueryData(queryKeys.rustToolchain(projectPath, wtPath), response);
  } catch (err) {
    showToast(err instanceof Error ? err.message : "Could not set the Rust toolchain");
  }
}
