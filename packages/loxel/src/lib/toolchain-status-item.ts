import type { ComponentType } from "react";

import type { RegisteredToolchain } from "@/api/toolchain-status-model";

/**
 * One language's toolchain in the renderer: its status bar item and its picker. Items are listed in
 * `toolchain-status-items.ts`. See docs/LANGUAGE_SERVERS.md.
 */
export interface ToolchainStatusItem {
  toolchain: RegisteredToolchain;
  /** Renders nothing unless the active editor holds a file of the language. */
  StatusItem: ComponentType;
  /** Lets the user choose worktree `wtPath`'s toolchain. */
  select: (wtPath: string) => Promise<void>;
}
