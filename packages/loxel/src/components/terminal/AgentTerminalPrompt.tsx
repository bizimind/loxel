import { useState } from "react";
import { createPortal } from "react-dom";

import {
  type AgentTerminalAnswer,
  type AgentTerminalAsk,
  agentName,
} from "@/api/agent-terminal-model";
import * as api from "@/api/client";
import { localServerId } from "@/api/local-server";
import { Button } from "@/components/ui/button";
import { RevealedText } from "@/components/ui/revealed-text";
import { showToast } from "@/components/ui/toast";
import { pathName } from "@/lib/project-file-helpers";
import { revealUnseen } from "@/lib/unseen-chars";
import { WINDOW_ID } from "@/lib/window-id";
import { useAgentTerminalsStore } from "@/store/agent-terminals";

const capitalized = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/**
 * Asks whether to start a terminal a coding agent asked for ("When an Agent Starts a Terminal" is
 * Ask), in the window the server asks in, one request at a time, until it is answered.
 */
export function AgentTerminalPrompt() {
  const asks = useAgentTerminalsStore((s) => s.asks);
  const mine = asks.filter((ask) => ask.windowId === WINDOW_ID);
  const ask = mine[0];
  if (!ask) return null;
  return createPortal(<AskCard key={ask.id} ask={ask} waiting={mine.length} />, document.body);
}

function AskCard({ ask, waiting }: { ask: AgentTerminalAsk; waiting: number }) {
  const [busy, setBusy] = useState(false);
  const where = ask.worktreePath === null ? "Home" : pathName(ask.worktreePath);

  const answer = (choice: AgentTerminalAnswer) => {
    setBusy(true);
    api
      // The asks are the window's own server's (its `agent_terminals_changed`).
      .answerAgentTerminal(localServerId(), ask.id, choice, WINDOW_ID)
      .catch((err: unknown) => {
        showToast(`Could not answer: ${err instanceof Error ? err.message : String(err)}`);
      })
      .finally(() => setBusy(false));
  };

  return (
    <div
      role="alertdialog"
      aria-label="Start a terminal?"
      className="animate-in slide-in-from-bottom-2 fade-in bg-popover border-border fixed bottom-4 left-1/2 z-[9998] flex w-96 max-w-[calc(100%-2rem)] -translate-x-1/2 flex-col gap-2 rounded-lg border px-3 py-2.5 shadow-lg"
    >
      <span className="text-foreground text-xs font-medium">
        <RevealedText text={capitalized(agentName(ask.origin))} /> wants to start a terminal in{" "}
        <RevealedText text={where} />
        {waiting > 1 ? ` (1 of ${waiting})` : ""}
      </span>
      {ask.cwd !== ask.worktreePath && (
        <span className="text-muted-foreground text-xs break-all">
          Starts in <RevealedText text={ask.cwd} />
        </span>
      )}
      {ask.command ? (
        <CommandPreview command={ask.command} />
      ) : (
        <span className="text-muted-foreground text-xs">
          An interactive shell, with no command.
        </span>
      )}
      <div className="flex justify-end gap-1.5">
        <Button variant="outline" size="xs" disabled={busy} onClick={() => answer("decline")}>
          Don&apos;t run
        </Button>
        {ask.worktreePath !== null && (
          <Button variant="outline" size="xs" disabled={busy} onClick={() => answer("always")}>
            Always in this worktree
          </Button>
        )}
        <Button size="xs" disabled={busy} onClick={() => answer("run")}>
          Run
        </Button>
      </div>
    </div>
  );
}

/**
 * The command as the shell will receive it: every line, its line count when there are several, and
 * characters that would not show (controls, bidirectional and zero-width characters) spelled as
 * escapes.
 */
function CommandPreview({ command }: { command: string }) {
  const lineCount = command.split("\n").length;
  const hasUnseen = revealUnseen(command).some((run) => run.unseen);
  const notes = [
    lineCount > 1 ? `The command has ${lineCount} lines.` : null,
    hasUnseen ? "Characters that do not print are shown as escapes." : null,
  ].filter((note) => note !== null);

  return (
    <>
      {notes.length > 0 && <span className="text-warning text-xs">{notes.join(" ")}</span>}
      <code className="text-foreground bg-muted max-h-24 overflow-y-auto rounded px-1.5 py-1 text-[11px] break-all whitespace-pre-wrap">
        <RevealedText text={command} />
      </code>
    </>
  );
}
