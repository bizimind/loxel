/**
 * The agent panel: a Claude Code session driven by Loxel instead of shown in a terminal. A quiet
 * transcript with what waits on the user raised in place, and one composer surface whose footer
 * holds the session's model, effort and mode, with a status line above it and a hand-off to a
 * terminal for anything the panel does not show. Escape twice rewinds, as in the terminal.
 */
import type { DockviewPanelApi } from "dockview-react";
import { HistoryIcon, PlayIcon } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import { type AgentRequest, type AgentState, agentDisplayStatus } from "@/api/agent-session-model";
import { fetchJson } from "@/api/client";
import { Button } from "@/components/ui/button";
import { frontendLog } from "@/lib/frontend-logger";
import { dispatchLoxelEvent } from "@/lib/loxel-events";
import { isUuid } from "@/lib/uuid";
import { WINDOW_ID } from "@/lib/window-id";
import { useAgentStatusStore } from "@/store/agent-status";

import { AgentComposer } from "./AgentComposer";
import { AgentControls, AgentStatusLine } from "./AgentControls";
import { AgentRequestCard, REQUEST_CARD_ATTR } from "./AgentRequestCard";
import {
  DOUBLE_ESCAPE_MS,
  forkPoint,
  type RewindChoice,
  RewindCard,
  rewindableMessages,
} from "./AgentRewind";
import { AgentSessionPicker, type SessionAction } from "./AgentSessionPicker";
import { AgentTranscript } from "./AgentTranscript";
import { useAgentSession } from "./use-agent-session";

const uiLog = frontendLog.child("ui");

export interface AgentPanelParams {
  agentId: string;
  worktreePath: string;
  /** Claude Code's session id once the server has one, so a restart can resume it. */
  sessionId?: string;
  /** A panel forked from another session ("Fork from here"), until its fork has a message. */
  forkFrom?: { sessionId: string; at?: string };
}

function StoppedNote({ state }: { state: AgentState }) {
  if (state.handedOff) {
    return (
      <p className="text-muted-foreground text-center text-[13px]">
        This session continues in a terminal. Quit Claude there before resuming it here.
      </p>
    );
  }
  if (state.status === "failed" && state.error) {
    return (
      <p className="text-destructive text-center text-[13px] whitespace-pre-wrap">{state.error}</p>
    );
  }
  if (state.status === "exited") {
    return <p className="text-muted-foreground text-center text-[13px]">The session stopped.</p>;
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
    forkFrom: params.forkFrom,
  });
  const { state, send, error, rewindPreview, promptHistory, sessions } = session;
  const status = agentDisplayStatus(state);
  const scrollRef = useStickToBottom(state);
  const composerRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    useAgentStatusStore.getState().setStatus(params.agentId, status);
  }, [params.agentId, status]);

  // The layout keeps the session id, so a server restart resumes this conversation.
  useEffect(() => {
    if (state.sessionId && state.sessionId !== params.sessionId) {
      panelApi.updateParameters({ sessionId: state.sessionId });
    }
  }, [state.sessionId, params.sessionId, panelApi]);

  // The terminal opens once the server reports the process gone, so the two never run at once.
  const handOffRequested = useRef(false);
  useEffect(() => {
    if (!handOffRequested.current || !state.handedOff || !state.sessionId) return;
    handOffRequested.current = false;
    if (!isUuid(state.sessionId)) return;
    fetchJson("/open", {
      method: "POST",
      body: JSON.stringify({
        terminal: {
          cwd: params.worktreePath,
          command: `claude --resume ${state.sessionId}`,
          title: "Claude",
        },
        pinWtPath: params.worktreePath,
        windowId: WINDOW_ID,
      }),
    }).catch((err: unknown) => {
      uiLog.error("Could not open the session in a terminal", { error: err });
    });
  }, [state.handedOff, state.sessionId, params.worktreePath]);

  const continueInTerminal = () => {
    if (state.sessionId && send({ type: "hand_off" })) handOffRequested.current = true;
  };

  const showRequest = () => {
    const card = scrollRef.current?.querySelector(`[${REQUEST_CARD_ATTR}]`);
    if (!(card instanceof HTMLElement)) return;
    card.scrollIntoView({ block: "center", behavior: "smooth" });
    card.focus({ preventScroll: true });
  };

  const renderRequest = useCallback(
    (request: AgentRequest) => (
      <AgentRequestCard
        request={request}
        respond={(response) => {
          send({ type: "respond", requestId: request.requestId, response });
          composerRef.current?.focus();
        }}
      />
    ),
    [send],
  );

  const working = status === "working" || status === "needs_input";
  const canSend = !state.handedOff && status !== "exited" && status !== "failed";

  // Rewind: select a message, then choose what to restore.
  const [rewind, setRewind] = useState<{ id: string; choosing: boolean } | null>(null);
  const [restore, setRestore] = useState<{ text: string; key: number } | null>(null);
  const lastEscape = useRef(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const rewindable = rewindableMessages(state.items);
  const selected = rewindable.find((m) => m.id === rewind?.id) ?? null;

  const leaveRewind = () => {
    setRewind(null);
    composerRef.current?.focus();
  };
  const chooseRewind = (choice: RewindChoice) => {
    if (!selected) return;
    setRewind(null);
    if (choice === "fork") {
      if (!state.sessionId) return;
      const at = forkPoint(rewindable, selected.id);
      dispatchLoxelEvent("loxel-create-agent", {
        forkFrom: { sessionId: state.sessionId, ...(at ? { at } : {}) },
      });
      return;
    }
    if (send({ type: "rewind", messageId: selected.id, ...choice }) && choice.conversation) {
      setRestore({ text: selected.text, key: Date.now() });
    }
  };

  // Sessions: the picker, `/resume` and "Continue latest".
  const [pickerOpen, setPickerOpen] = useState(false);
  const openPicker = () => {
    setPickerOpen(true);
    send({ type: "list_sessions" });
  };
  const openSession = (sessionId: string, action: SessionAction) => {
    setPickerOpen(false);
    send({ type: "open_session", action, sessionId });
    composerRef.current?.focus();
  };

  const onPanelKeyDown = (e: React.KeyboardEvent) => {
    if (rewind && !rewind.choosing) {
      const index = rewindable.findIndex((m) => m.id === rewind.id);
      if (e.key === "ArrowUp" || e.key === "ArrowDown") {
        e.preventDefault();
        const next = rewindable[index + (e.key === "ArrowUp" ? -1 : 1)];
        if (next) setRewind({ id: next.id, choosing: false });
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        setRewind({ id: rewind.id, choosing: true });
        send({ type: "rewind_preview", messageId: rewind.id });
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        leaveRewind();
      }
      return;
    }
    // Escape twice, with nothing typed and nothing running, as in the terminal. Handled Escapes
    // (closing the command list, interrupting) never reach here.
    if (e.key !== "Escape" || e.defaultPrevented || working || state.handedOff) return;
    const inComposer = e.target === composerRef.current;
    if (inComposer && composerRef.current?.value.trim()) return;
    const now = Date.now();
    if (now - lastEscape.current > DOUBLE_ESCAPE_MS) {
      lastEscape.current = now;
      return;
    }
    lastEscape.current = 0;
    const last = rewindable.at(-1);
    if (!last) return;
    e.preventDefault();
    setRewind({ id: last.id, choosing: false });
    rootRef.current?.focus();
  };

  return (
    <div
      ref={rootRef}
      tabIndex={-1}
      onKeyDown={onPanelKeyDown}
      className="bg-editor-surface flex h-full min-h-0 flex-col outline-none"
    >
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[820px] space-y-5 px-10 pt-10 pb-6 max-md:px-5">
          {state.items.length === 0 && state.pending.length === 0 && (
            <div className="pt-[18vh] text-center">
              <p className="text-foreground text-[18px] font-semibold">
                {status === "starting" ? "Starting Claude Code…" : "What should Claude work on?"}
              </p>
              <p className="text-muted-foreground mt-1.5 text-[13px]">
                Type / for commands and skills. Enter sends, and queues while Claude works.
              </p>
              {status !== "starting" && (
                <div className="mt-4 flex justify-center gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => send({ type: "open_session", action: "continue" })}
                  >
                    <PlayIcon /> Continue latest
                  </Button>
                  <Button size="sm" variant="ghost" onClick={openPicker}>
                    <HistoryIcon /> Resume a session…
                  </Button>
                </div>
              )}
            </div>
          )}
          <AgentTranscript
            items={state.items}
            pending={state.pending}
            renderRequest={renderRequest}
            selectedId={rewind ? rewind.id : null}
          />
          <StoppedNote state={state} />
        </div>
      </div>
      <div className="mx-auto w-full max-w-[820px] px-10 pb-3 max-md:px-5">
        {error && <p className="text-destructive mb-1 px-1 text-[12px]">{error}</p>}
        {rewind?.choosing && selected && (
          <RewindCard
            message={selected}
            preview={rewindPreview?.messageId === selected.id ? rewindPreview.preview : undefined}
            onChoose={chooseRewind}
            onCancel={leaveRewind}
          />
        )}
        {rewind && !rewind.choosing ? (
          <div className="text-muted-foreground flex h-6 items-center gap-1.5 px-1 text-[12px]">
            <HistoryIcon className="text-ring size-3" />
            <span className="text-foreground">Rewind</span>· ↑↓ to pick a message · Enter to choose
            what to restore · Esc to cancel
          </div>
        ) : (
          <AgentStatusLine
            state={state}
            send={send}
            onShowRequest={showRequest}
            onContinueInTerminal={continueInTerminal}
            onShowSessions={openPicker}
          />
        )}
        <AgentComposer
          commands={state.commands}
          history={promptHistory}
          restore={restore}
          working={working}
          disabled={!canSend}
          textareaRef={composerRef}
          controls={<AgentControls state={state} send={send} />}
          onSend={(text, images, delivery) => {
            // `/resume` lists sessions in the terminal; here it opens the picker.
            if (/^\/resume\s*$/.test(text) && images.length === 0) {
              openPicker();
              return true;
            }
            return send({ type: "send", id: crypto.randomUUID(), text, images, delivery });
          }}
          onInterrupt={() => send({ type: "interrupt" })}
        />
      </div>
      <AgentSessionPicker
        isOpen={pickerOpen}
        sessions={sessions}
        currentSessionId={state.sessionId}
        onClose={() => setPickerOpen(false)}
        onOpen={openSession}
      />
    </div>
  );
}
