import { toolchainStatuses } from "./toolchain-statuses";

/**
 * What server and renderer both need to know about a language's toolchain status item. A static
 * list (`toolchain-statuses.ts`) because the WebSocket protocol and the action registry are unions
 * of literal types. The behavior lives in the language's `ToolchainStatusModule` on the server and
 * `ToolchainStatusItem` in the renderer. See docs/LANGUAGE_SERVERS.md.
 */
export interface ToolchainStatusDescriptor {
  /** Names the toolchain in query keys, and pairs its server and renderer modules. */
  id: string;
  /** Monaco languages whose active editor shows the status item. */
  languageIds: readonly string[];
  /** The WebSocket message type saying a worktree's toolchain may have changed. */
  changedMessage: string;
  /** The command that opens the picker. Unbound by default. */
  selectAction: { id: string; label: string };
}

export type RegisteredToolchain = (typeof toolchainStatuses)[number];

/** A worktree's toolchain may have changed (re-detected, or its override changed). */
export interface ToolchainChangedMessage {
  type: RegisteredToolchain["changedMessage"];
  wtPath: string;
}

export type ToolchainSelectActionId = RegisteredToolchain["selectAction"]["id"];

const CHANGED_MESSAGES: ReadonlySet<string> = new Set(
  toolchainStatuses.map((toolchain) => toolchain.changedMessage),
);
const SELECT_ACTION_IDS: ReadonlySet<string> = new Set(
  toolchainStatuses.map((toolchain) => toolchain.selectAction.id),
);

export function isToolchainChangedMessage(message: {
  type: string;
}): message is ToolchainChangedMessage {
  return CHANGED_MESSAGES.has(message.type);
}

export function isToolchainSelectAction(actionId: string): actionId is ToolchainSelectActionId {
  return SELECT_ACTION_IDS.has(actionId);
}
