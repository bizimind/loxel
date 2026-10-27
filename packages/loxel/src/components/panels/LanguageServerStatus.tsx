import { TriangleAlertIcon } from "lucide-react";

import { restartStoppedLanguageServers } from "@/lib/lsp-client";
import type { LspStopReason } from "@/lib/lsp-connection";
import { useLspStatusStore } from "@/store/lsp-status";

const REASON_TEXT: Record<LspStopReason, string> = {
  crashed: "kept crashing",
  "start-failed": "could not start",
  unreachable: "lost its connection to Loxel",
  replaced: "is in use by another window on this worktree",
};

/**
 * The language servers that stopped (crashed repeatedly, could not start, lost Loxel's server, or
 * moved to another window), shown only while there are any. Clicking it restarts them.
 */
export function LanguageServerStatus() {
  const stopped = useLspStatusStore((s) => s.stopped);
  if (stopped.size === 0) return null;

  const servers = [...stopped.values()];
  const [only] = servers;
  let label = `${servers.length} language servers stopped`;
  if (servers.length === 1 && only) {
    label = only.reason === "replaced" ? `${only.name} in another window` : `${only.name} stopped`;
  }
  const tooltip = [
    ...servers.map(({ name, reason, detail }) => {
      const line = `${name} ${REASON_TEXT[reason]}`;
      return reason === "start-failed" && detail ? `${line}: ${detail}` : line;
    }),
    "Click to restart",
  ].join("\n");

  return (
    <button
      type="button"
      onClick={restartStoppedLanguageServers}
      title={tooltip}
      className="text-warning hover:text-foreground flex cursor-pointer items-center gap-1 transition-colors"
    >
      <TriangleAlertIcon className="size-3.5" />
      {label}
    </button>
  );
}
