import { withScope } from "./client";
import type {
  RustToolchainCandidatesResponse,
  RustToolchainChoiceRequest,
  RustToolchainResponse,
} from "./rust-toolchain-model";
import { connectionOf } from "./server-connection";
import type { WorktreeRef } from "./worktree-ref";

export async function getRustToolchain(wt: WorktreeRef): Promise<RustToolchainResponse> {
  return connectionOf(wt.server).fetchJson<RustToolchainResponse>(
    withScope("/rust-toolchain", { wt: wt.path }),
  );
}

export async function getRustToolchainCandidates(
  wt: WorktreeRef,
): Promise<RustToolchainCandidatesResponse> {
  return connectionOf(wt.server).fetchJson<RustToolchainCandidatesResponse>(
    withScope("/rust-toolchain/candidates", { wt: wt.path }),
  );
}

/** Choose the worktree's toolchain, or return it to automatic detection with null. */
export async function setRustToolchainChoice(
  wt: WorktreeRef,
  choice: Omit<RustToolchainChoiceRequest, "worktreePath">,
): Promise<RustToolchainResponse> {
  return connectionOf(wt.server).fetchJson<RustToolchainResponse>("/rust-toolchain/choice", {
    method: "POST",
    body: JSON.stringify({ worktreePath: wt.path, ...choice }),
  });
}
