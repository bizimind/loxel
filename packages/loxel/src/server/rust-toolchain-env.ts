/**
 * Rust's contribution to terminal environments: `RUSTUP_TOOLCHAIN` for a toolchain the user chose
 * for the worktree. Detection changes nothing here, since rustup's proxies follow a toolchain file
 * in a terminal by themselves. `RUSTUP_AUTO_INSTALL` stays out: `cargo` in a terminal is the user's
 * own, and is how they download. See docs/languages/rust.md.
 */
import { getRustToolchain, rustChosenEnv } from "./rust-toolchain";
import { getRustChoice } from "./rust-toolchain-store";
import type { TerminalEnvChange, ToolchainEnvContributor } from "./toolchain-env-contributor";

/** Without a choice this runs nothing, so a worktree with no Rust in it pays nothing. */
async function resolveChange(worktreePath: string): Promise<TerminalEnvChange | null> {
  if (getRustChoice(worktreePath) === null) return null;
  const { RUSTUP_TOOLCHAIN: toolchain } = rustChosenEnv(await getRustToolchain(worktreePath));
  if (!toolchain) return null;
  return (spawnEnv) => {
    spawnEnv.RUSTUP_TOOLCHAIN = toolchain;
  };
}

export const rustToolchainEnv: ToolchainEnvContributor = {
  name: "Rust",
  resolveForTerminal: resolveChange,
};
