import { fetchJson, withScope } from "./client";
import type {
  RustToolchainCandidatesResponse,
  RustToolchainChoiceRequest,
  RustToolchainResponse,
} from "./rust-toolchain-model";

export async function getRustToolchain(worktreePath: string): Promise<RustToolchainResponse> {
  return fetchJson<RustToolchainResponse>(withScope("/rust-toolchain", { wt: worktreePath }));
}

export async function getRustToolchainCandidates(
  worktreePath: string,
): Promise<RustToolchainCandidatesResponse> {
  return fetchJson<RustToolchainCandidatesResponse>(
    withScope("/rust-toolchain/candidates", { wt: worktreePath }),
  );
}

/** Choose the worktree's toolchain, or return it to automatic detection with null. */
export async function setRustToolchainChoice(
  request: RustToolchainChoiceRequest,
): Promise<RustToolchainResponse> {
  return fetchJson<RustToolchainResponse>("/rust-toolchain/choice", {
    method: "POST",
    body: JSON.stringify(request),
  });
}
