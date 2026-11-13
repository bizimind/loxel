/**
 * The agent panel: a Claude Code session driven by Loxel instead of shown in a terminal. The
 * transcript, the requests waiting on the user and the composer, with the session's model,
 * effort and permission mode in the header, and a hand-off to a terminal for anything else.
 */
import type { DockviewPanelApi } from "dockview-react";
import { GaugeIcon, PlayIcon, SquareTerminalIcon } from "lucide-react";
import { useEffect, useLayoutEffect, useRef } from "react";

import {
  AGENT_PERMISSION_MODES,
  type AgentPermissionMode,
  agentDisplayStatus,
  type AgentState,
  isAgentPermissionMode,
} from "@/api/agent-session-model";
import { fetchJson } from "@/api/client";
import { Button } from "@/components/ui/button";
import { frontendLog } from "@/lib/frontend-logger";
import { isUuid } from "@/lib/uuid";
import { WINDOW_ID } from "@/lib/window-id";
import { useAgentStatusStore } from "@/store/agent-status";

import { AgentComposer } from "./AgentComposer";
import { AgentRequestCard } from "./AgentRequestCard";
import { AgentTranscript } from "./AgentTranscript";
import { type AgentSessionHandle, useAgentSession } from "./use-agent-session";

const uiLog = frontendLog.child("ui");

export interface AgentPanelParams {
  agentId: string;
  worktreePath: string;
  /** Claude Code's session id once the server has one, so a restart can resume it. */
  sessionId?: string;
}

const MODE_LABELS: Record<AgentPermissionMode, string> = {
  default: "Ask before edits",
  acceptEdits: "Accept edits",
  plan: "Plan",
  auto: "Auto",
  dontAsk: "Don't ask",
  bypassPermissions: "Bypass permissions",
};

const selectClass =
  "border-border bg-background text-foreground h-6 rounded border px-1 text-[11px] outline-none focus-visible:border-ring disabled:opacity-50";

function Toolbar({ session, worktreePath }: { session: AgentSessionHandle; worktreePath: string }) {
  const { state, send } = session;
  const running = !state.handedOff && state.status !== "exited" && state.status !== "failed";
  const model = state.models.find(
    (m) => m.value === state.model || m.resolvedModel === state.model,
  );
  const effortLevels = model?.effortLevels ?? [];

  // The terminal opens once the server reports the process gone, so the two never run at once.
  const handOffRequested = useRef(false);
  useEffect(() => {
    if (!handOffRequested.current || !state.handedOff || !state.sessionId) return;
    handOffRequested.current = false;
    if (!isUuid(state.sessionId)) return;
    void fetchJson("/open", {
      method: "POST",
      body: JSON.stringify({
        terminal: {
          cwd: worktreePath,
          command: `claude --resume ${state.sessionId}`,
          title: "Claude",
        },
        pinWtPath: worktreePath,
        windowId: WINDOW_ID,
      }),
    }).catch((err: unknown) =>
      uiLog.error("Could not open the session in a terminal", { error: err }),
    );
  }, [state.handedOff, state.sessionId, worktreePath]);

  const continueInTerminal = () => {
    if (state.sessionId && send({ type: "hand_off" })) handOffRequested.current = true;
  };

  return (
    <div className="border-border flex h-8 shrink-0 items-center gap-1.5 overflow-x-auto border-b px-2">
      <select
        aria-label="Model"
        className={selectClass}
        disabled={!running || state.models.length === 0}
        value={model?.value ?? ""}
        onChange={(e) => send({ type: "set_model", model: e.target.value })}
      >
        {!model && <option value="">{state.model ?? "Model"}</option>}
        {state.models.map((m) => (
          <option key={m.value} value={m.value} title={m.description}>
            {m.displayName}
          </option>
        ))}
      </select>
      {effortLevels.length > 0 && (
        <select
          aria-label="Effort"
          className={selectClass}
          disabled={!running}
          value={state.effort ?? ""}
          onChange={(e) => send({ type: "set_effort", effort: e.target.value })}
        >
          <option value="" disabled>
            Effort
          </option>
          {effortLevels.map((level) => (
            <option key={level} value={level}>
              {level}
            </option>
          ))}
        </select>
      )}
      <select
        aria-label="Permission mode"
        className={selectClass}
        disabled={!running}
        value={state.permissionMode ?? ""}
        onChange={(e) => {
          if (isAgentPermissionMode(e.target.value)) {
            send({ type: "set_permission_mode", mode: e.target.value });
          }
        }}
      >
        {!state.permissionMode && <option value="">Mode</option>}
        {AGENT_PERMISSION_MODES.map((mode) => (
          <option key={mode} value={mode}>
            {MODE_LABELS[mode]}
          </option>
        ))}
      </select>
      <button
        type="button"
        disabled={!running}
        onClick={() => send({ type: "refresh_context_usage" })}
        title="Context window usage (refresh)"
        className="text-muted-foreground hover:text-foreground flex items-center gap-1 text-[11px] disabled:opacity-50"
      >
        <GaugeIcon className="size-3" />
        {state.contextUsage ? `${Math.round(state.contextUsage.percentage)}%` : "Context"}
      </button>
      <div className="ml-auto flex items-center gap-1.5">
        {running ? (
          <Button
            size="xs"
            variant="ghost"
            disabled={!state.sessionId}
            onClick={continueInTerminal}
            title="Stop here and continue this session in a terminal, for anything this panel does not show"
          >
            <SquareTerminalIcon /> Continue in terminal
          </Button>
        ) : (
          <Button size="xs" variant="ghost" onClick={() => send({ type: "resume" })}>
            <PlayIcon /> Resume here
          </Button>
        )}
      </div>
    </div>
  );
}

function StatusBanner({ state }: { state: AgentState }) {
  if (state.handedOff) {
    return (
      <p className="text-muted-foreground text-center text-xs">
        This session continues in a terminal. Quit Claude there before resuming it here.
      </p>
    );
  }
  if (state.status === "failed" && state.error) {
    return (
      <p className="text-destructive text-center text-xs whitespace-pre-wrap">{state.error}</p>
    );
  }
  if (state.status === "exited") {
    return <p className="text-muted-foreground text-center text-xs">The session stopped.</p>;
  }
  return null;
}

/** Keeps the transcript pinned to its end while it grows, unless the user scrolled up. */
function useStickToBottom(dependency: unknown) {
  const ref = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onScroll = () => {
      pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [dependency]);
  return ref;
}

export function AgentPanel({
  params,
  panelApi,
}: {
  params: AgentPanelParams;
  panelApi: DockviewPanelApi;
}) {
  const session = useAgentSession({
    agentId: params.agentId,
    worktreePath: params.worktreePath,
    sessionId: params.sessionId,
  });
  const { state, send, error } = session;
  const status = agentDisplayStatus(state);
  const scrollRef = useStickToBottom(state);

  useEffect(() => {
    useAgentStatusStore.getState().setStatus(params.agentId, status);
  }, [params.agentId, status]);

  // The layout keeps the session id, so a server restart resumes this conversation.
  useEffect(() => {
    if (state.sessionId && state.sessionId !== params.sessionId) {
      panelApi.updateParameters({ sessionId: state.sessionId });
    }
  }, [state.sessionId, params.sessionId, panelApi]);

  const working = status === "working" || status === "needs_input";
  const canSend = !state.handedOff && status !== "exited" && status !== "failed";

  return (
    <div className="bg-editor-surface flex h-full min-h-0 flex-col">
      <Toolbar session={session} worktreePath={params.worktreePath} />
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[960px] space-y-4 px-12 py-8 max-md:px-5">
          {state.items.length === 0 && status !== "failed" && (
            <p className="text-muted-foreground pt-16 text-center text-sm">
              {status === "starting" ? "Starting Claude Code…" : "What should Claude work on?"}
            </p>
          )}
          <AgentTranscript items={state.items} />
          <StatusBanner state={state} />
        </div>
      </div>
      <div className="mx-auto w-full max-w-[960px] space-y-2 px-12 pb-4 max-md:px-5">
        {state.pending.map((request) => (
          <AgentRequestCard
            key={request.requestId}
            request={request}
            respond={(response) =>
              send({ type: "respond", requestId: request.requestId, response })
            }
          />
        ))}
        {error && <p className="text-destructive text-xs">{error}</p>}
        <AgentComposer
          commands={state.commands}
          working={working}
          disabled={!canSend}
          onSend={(text, images, delivery) =>
            send({ type: "send", id: crypto.randomUUID(), text, images, delivery })
          }
          onInterrupt={() => send({ type: "interrupt" })}
        />
      </div>
    </div>
  );
}
