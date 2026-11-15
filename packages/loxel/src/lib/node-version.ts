import { getNodeEnvCandidates, setNodeOverride } from "@/api/node-env-client";
import { type NodeEnv, type NodeInstall, nodeToolchain } from "@/api/node-env-model";
import { showToast } from "@/components/ui/toast";
import { setToolchainStatusData } from "@/queries/use-toolchain-status";
import { type QuickPickItem, requestQuickPick } from "@/store/command-palette";
import { useProjectStore } from "@/store/projects";

import { abbreviateHomePath } from "./home-path";

// A picker id that cannot collide with a `node` path, which is always absolute.
const AUTOMATIC_ID = "#automatic";

/** The installation as shown in the status bar and picker, e.g. `Node 22.11.0 (nvm)`. */
export function nodeInstallLabel(install: NodeInstall): string {
  const version = install.version ? `Node ${install.version}` : "Node";
  return `${version} (${install.manager ?? "PATH"})`;
}

/** How the Node was chosen, for tooltips. */
export function nodeSourceDescription(env: NodeEnv, pinFile: string | null): string {
  if (env.source === "override") return "Chosen for this worktree";
  if (env.source === "pin") return `Pinned by ${pinFile ?? "the project"}`;
  return "Found on the login-shell PATH";
}

/**
 * Let the user choose worktree `wtPath`'s Node in the command palette: an installed version, the
 * one on `PATH`, or automatic detection. The choice is saved per worktree on the server.
 */
export async function selectNodeVersion(wtPath: string): Promise<void> {
  const { homeDir } = useProjectStore.getState();
  const items = getNodeEnvCandidates(wtPath).then(({ candidates, automaticPath, overridePath }) => {
    const automatic = candidates.find((c) => c.nodePath === automaticPath);
    const list: QuickPickItem[] = [
      {
        id: AUTOMATIC_ID,
        label: "Use automatic detection",
        description: automatic ? nodeInstallLabel(automatic) : "No Node found",
        current: overridePath === null,
      },
      ...candidates.map((c) => ({
        id: c.nodePath,
        label: nodeInstallLabel(c),
        description: abbreviateHomePath(c.nodePath, homeDir),
        current: c.nodePath === overridePath,
      })),
    ];
    return list;
  });

  const picked = await requestQuickPick({ placeholder: "Select a Node version", items });
  if (picked === null) return;

  try {
    const response = await setNodeOverride({
      worktreePath: wtPath,
      nodePath: picked === AUTOMATIC_ID ? null : picked,
    });
    setToolchainStatusData(nodeToolchain, wtPath, response);
  } catch (err) {
    showToast(err instanceof Error ? err.message : "Could not set the Node version");
  }
}
