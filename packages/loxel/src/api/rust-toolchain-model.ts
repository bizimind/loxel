import type { ToolchainStatusDescriptor } from "./toolchain-status-model";

/** Why a toolchain is the active one for a worktree. */
export type RustToolchainSource =
  /** The user chose it for the worktree in Loxel. */
  | "chosen"
  /** `rust-toolchain.toml` or `rust-toolchain`. */
  | "toolchain-file"
  /** `RUSTUP_TOOLCHAIN` in the environment Loxel inherited. */
  | "environment"
  /** `rustup override set`. */
  | "directory-override"
  /** The rustup default. */
  | "default"
  /** A Rust installed without rustup (Homebrew, a distro package). */
  | "no-rustup"
  /** rustup gave a reason this version of Loxel does not recognize. */
  | "unknown";

/** What a worktree's toolchain offers. A null path means the tool is unavailable. */
export interface RustTools {
  /** Path to spawn: rustup's proxy when there is one, so it honors the worktree's toolchain. */
  cargo: string | null;
  rustfmt: string | null;
  cargoClippy: string | null;
  rustAnalyzer: string | null;
  /** The `rust-src` component (the standard library's sources) is installed. */
  rustSrc: boolean;
}

/** A worktree's Rust toolchain. Only an `active` one has anything to run. */
export type RustToolchain =
  | {
      status: "active";
      source: RustToolchainSource;
      /** rustup's name, such as `stable-aarch64-apple-darwin`; null without rustup. */
      name: string | null;
      /** Version reported by `rustc --version`, e.g. `1.99.1`; null when it could not be read. */
      version: string | null;
      /** The compiler itself, not a rustup proxy, when rustup manages it. */
      rustcPath: string;
      /** The toolchain's root; null when it could not be read. */
      sysroot: string | null;
      /** The toolchain file that selected it, for the `toolchain-file` source. */
      toolchainFile: string | null;
      tools: RustTools;
    }
  /** Selected, by a toolchain file for example, but not installed. Loxel never installs it. */
  | {
      status: "not-installed";
      source: RustToolchainSource;
      name: string;
      toolchainFile: string | null;
    }
  /** Selected, but the repository ships it, so Loxel runs nothing from it. */
  | { status: "refused"; name: string; toolchainFile: string | null; rustcPath: string }
  | {
      status: "none";
      /** The rustup found, when rustup is what has no usable toolchain. */
      rustupPath: string | null;
      /** What rustup reported, when it is more than having no toolchain. */
      detail: string | null;
    };

/** An installed toolchain the user can choose for a worktree. */
export interface RustToolchainChoice {
  name: string;
  /** The toolchain's root directory. */
  path: string;
  version: string | null;
}

/** `GET /api/rust-toolchain?wt=` response. */
export interface RustToolchainResponse {
  toolchain: RustToolchain;
  /** Toolchain chosen for the worktree, even when it is not usable and detection took over. */
  chosen: string | null;
}

/** `GET /api/rust-toolchain/candidates?wt=` response. */
export interface RustToolchainCandidatesResponse {
  candidates: RustToolchainChoice[];
  /** What automatic detection picks. */
  automatic: RustToolchain;
  chosen: string | null;
}

/** `POST /api/rust-toolchain/choice` body; a null `toolchain` returns to automatic detection. */
export interface RustToolchainChoiceRequest {
  worktreePath: string;
  toolchain: string | null;
}

export const rustToolchain = {
  id: "rust",
  languageIds: ["rust"],
  changedMessage: "rust_toolchain_changed",
  selectAction: { id: "rust.selectToolchain", label: "Rust: Select Toolchain" },
} as const satisfies ToolchainStatusDescriptor;
