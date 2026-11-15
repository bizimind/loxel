import { getGoToolchainCandidates, refreshGoEnv, setGoToolchainChoice } from "@/api/go-env-client";
import { type GoEnv, type GoEnvResponse, goToolchain } from "@/api/go-env-model";
import { showToast } from "@/components/ui/toast";
import { setToolchainStatusData } from "@/queries/use-toolchain-status";
import { type QuickPickItem, requestQuickPick, requestTextInput } from "@/store/command-palette";
import { useProjectStore } from "@/store/projects";

import { abbreviateHomePath } from "./home-path";
import { restartStoppedLanguageServers } from "./lsp-client";

// Picker ids that cannot collide with a Go's path, which is always absolute.
const AUTOMATIC_ID = "#automatic";
const ENTER_PATH_ID = "#enter-path";

function showGoStatus(wtPath: string, status: GoEnvResponse): void {
  setToolchainStatusData(goToolchain, wtPath, status);
  // The user asked, so a gopls that stopped for lack of Go may start again.
  if (status.env) restartStoppedLanguageServers();
}

/** Look for the worktree's Go again, for one installed in a directory new to the login-shell PATH. */
export async function refreshGoToolchain(wtPath: string): Promise<void> {
  try {
    showGoStatus(wtPath, await refreshGoEnv(wtPath));
  } catch (err) {
    showToast(err instanceof Error ? err.message : "Could not look for Go");
  }
}

function automaticDescription(env: GoEnv | null, homeDir: string | null): string {
  if (!env) return "No Go found";
  const version = env.version ? `Go ${env.version}` : "Go";
  return `${version}, ${abbreviateHomePath(env.binary, homeDir)}`;
}

/**
 * Let the user choose worktree `wtPath`'s Go in the command palette: one found on the machine, a
 * path they enter, or automatic detection. The choice is saved per worktree on the server, which
 * everything that runs Go follows. Opening it also looks for Go again. Installing Go is left to the
 * user's terminal.
 */
export async function selectGoToolchain(wtPath: string): Promise<void> {
  const { homeDir } = useProjectStore.getState();
  const state = refreshGoToolchain(wtPath).then(() => getGoToolchainCandidates(wtPath));
  const items = state.then(({ candidates, automatic, chosen }) => {
    const list: QuickPickItem[] = [
      {
        id: AUTOMATIC_ID,
        label: "Use automatic detection",
        description: automaticDescription(automatic, homeDir),
        current: chosen === null,
      },
      { id: ENTER_PATH_ID, label: "Enter a path to Go…" },
      ...candidates.map((choice) => {
        const shortPath = abbreviateHomePath(choice.path, homeDir);
        return {
          id: choice.path,
          label: `Go ${choice.version}`,
          description: choice.fromModuleCache ? `Module cache, ${shortPath}` : shortPath,
          current: choice.path === chosen,
        };
      }),
    ];
    return list;
  });

  const picked = await requestQuickPick({ placeholder: "Select a Go toolchain", items });
  if (picked === null) return;

  let goPath: string | null = picked === AUTOMATIC_ID ? null : picked;
  if (picked === ENTER_PATH_ID) {
    const { chosen } = await state;
    goPath = await requestTextInput({
      placeholder: "Path to a Go binary or GOROOT",
      value: chosen ?? "",
    });
    if (goPath === null) return;
  }

  try {
    showGoStatus(wtPath, await setGoToolchainChoice({ worktreePath: wtPath, goPath }));
  } catch (err) {
    showToast(err instanceof Error ? err.message : "Could not set the Go toolchain");
  }
}
