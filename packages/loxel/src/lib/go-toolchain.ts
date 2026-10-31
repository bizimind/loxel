import { refreshGoEnv } from "@/api/go-env-client";
import { goToolchain } from "@/api/go-env-model";
import { showToast } from "@/components/ui/toast";
import { setToolchainStatusData } from "@/queries/use-toolchain-status";

import { restartStoppedLanguageServers } from "./lsp-client";

/**
 * Look for the worktree's Go again, for one installed in a directory new to the login-shell PATH.
 * The user asked for this, so a gopls that stopped for lack of Go may start again.
 */
export async function refreshGoToolchain(wtPath: string): Promise<void> {
  try {
    const status = await refreshGoEnv(wtPath);
    setToolchainStatusData(goToolchain, wtPath, status);
    if (status.env) restartStoppedLanguageServers();
  } catch (err) {
    showToast(err instanceof Error ? err.message : "Could not look for Go");
  }
}
