/**
 * Coding agent panel — the main dockview-hosted component.
 *
 * Manages the lifecycle of a single agent session: creates/reattaches on mount,
 * subscribes to WebSocket events, forwards user messages and approvals.
 */
import type { DockviewPanelApi } from "dockview-react";

import { useCallback, useEffect, useRef, useState } from "react";

import type { WsMessage } from "@/api/ws-protocol";

import { wsClient } from "@/api/client";
import { usePanelWorktreePath } from "@/components/dockview/panel-context";
import { usePanelActivationFocus } from "@/hooks/usePanelActivationFocus";
import { frontendLog } from "@/lib/frontend-logger";
import { openForkedAgent } from "@/lib/panel-creators";
import { useCodingAgentStore } from "@/store/coding-agent";
import { buildSessionOptions, useSettingsStore } from "@/store/settings-store";

import { CodingAgentInput } from "./CodingAgentInput";
import { CodingAgentTimeline } from "./CodingAgentTimeline";

const agentLog = frontendLog.child("agent");

export function CodingAgentPanel({
  sessionId,
  forkedSessionId,
  forkPointMessageId,
  panelApi,
}: {
  sessionId: string;
  forkedSessionId?: string;
  forkPointMessageId?: string;
  panelApi: DockviewPanelApi;
}) {
  const store = useCodingAgentStore;
  const session = useCodingAgentStore((s) => s.sessions[sessionId]);
  const panelWorktreePath = usePanelWorktreePath();
  const scopeKey = panelWorktreePath ?? "default";
  const [draftText, setDraftText] = useState<string | null>(null);
  const workspaceRoot = panelWorktreePath ?? ".";
  const inputRef = useRef<HTMLTextAreaElement>(null);

  usePanelActivationFocus(
    panelApi,
    useCallback(() => inputRef.current?.focus(), []),
  );

  // Initialize session and subscribe to WS events
  useEffect(() => {
    store.getState().initSession(sessionId);
    store.getState().setReplaying(sessionId, true);

    const unsub = wsClient.subscribe((msg: WsMessage) => {
      if (msg.type === "agent_event" && msg.id === sessionId) {
        store.getState().processEvent(sessionId, msg.event, msg.seq);

        // After fork, create a new agent tab for the forked session
        const eventType = msg.event.type;
        if (eventType === "session.forked") {
          const payload = msg.event.payload;
          const p =
            typeof payload === "object" && payload !== null
              ? (payload as Record<string, unknown>)
              : null;
          const forkedId = p ? String(p.session_id ?? "") : "";
          const forkPoint = p ? String(p.fork_point_message_id ?? "") : "";
          if (forkedId.length > 0) {
            openForkedAgent(forkedId, forkPoint || undefined);
            agentLog.info("Created forked agent tab", {
              forkedSessionId: forkedId,
              forkPointMessageId: forkPoint,
            });
          }
        }

        // Auto-send queued message when run finishes
        if (
          eventType === "run.completed" ||
          eventType === "run.failed" ||
          eventType === "run.cancelled"
        ) {
          const queued = store.getState().consumeQueuedMessage(sessionId);
          if (queued) {
            const agentSid = store.getState().sessions[sessionId]?.codingAgentSessionId;
            if (agentSid) {
              const queuedClientId = store.getState().addOptimisticUserMessage(sessionId, queued);
              wsClient.send({
                type: "agent_request",
                id: sessionId,
                request: {
                  type: "session.input",
                  request_id: crypto.randomUUID(),
                  session_id: agentSid,
                  messages: [{ id: queuedClientId, role: "user", content: queued }],
                },
              });
              agentLog.info("Sent queued message", { sessionId });
            }
          }
        }

        // Fetch session record for branch info after lifecycle events.
        // Message IDs are now resolved via message.received events, not session.get.
        if (
          eventType === "session.started" ||
          eventType === "session.resumed" ||
          eventType === "session.rewound" ||
          eventType === "session.forked"
        ) {
          const codingAgentSessionId = store.getState().sessions[sessionId]?.codingAgentSessionId;
          if (codingAgentSessionId) {
            wsClient.send({
              type: "agent_request",
              id: sessionId,
              request: {
                type: "session.get",
                request_id: crypto.randomUUID(),
                session_id: codingAgentSessionId,
              },
            });
          }
        }
      } else if (msg.type === "agent_replay_done" && msg.id === sessionId) {
        store.getState().setReplaying(sessionId, false);
        agentLog.info("Agent replay complete", { sessionId });
      } else if (msg.type === "agent_exit" && msg.id === sessionId) {
        store.getState().setStatus(sessionId, "exited", msg.exitCode);
        if (msg.exitCode === 0) {
          agentLog.info("Agent exited", { sessionId, exitCode: msg.exitCode });
        } else {
          agentLog.error("Agent exited", { sessionId, exitCode: msg.exitCode });
        }
      } else if (msg.type === "agent_error" && msg.id === sessionId) {
        store.getState().addErrorItem(sessionId, msg.message);
        agentLog.error("Agent error", { sessionId, message: msg.message });
      }
    });

    // Create or reattach the agent session
    const { codingAgent, models } = useSettingsStore.getState();
    const sessionOptions = buildSessionOptions(codingAgent, models);
    wsClient.send({
      type: "agent_create",
      id: sessionId,
      scopeKey,
      workspaceRoot,
      sessionOptions,
      forkedSessionId,
      forkPointMessageId,
    });
    agentLog.info("Agent session created", {
      sessionId,
      scopeKey,
      workspaceRoot,
      forkedSessionId,
      forkPointMessageId,
    });

    // Re-attach on WS reconnect (server may have restarted)
    const unsubReconnect = wsClient.onReconnect(() => {
      store.getState().setReplaying(sessionId, true);
      const fresh = useSettingsStore.getState();
      const freshOptions = buildSessionOptions(fresh.codingAgent, fresh.models);
      wsClient.send({
        type: "agent_create",
        id: sessionId,
        scopeKey,
        workspaceRoot,
        sessionOptions: freshOptions,
        forkedSessionId,
        forkPointMessageId,
      });
      agentLog.info("Agent session reattached", { sessionId });
    });

    return () => {
      unsub();
      unsubReconnect();
    };
  }, [sessionId, scopeKey, workspaceRoot, store, forkedSessionId, forkPointMessageId]);

  const handleSend = useCallback(
    (text: string) => {
      const codingAgentSessionId = store.getState().sessions[sessionId]?.codingAgentSessionId;
      if (!codingAgentSessionId) return;

      const clientMessageId = store.getState().addOptimisticUserMessage(sessionId, text);
      wsClient.send({
        type: "agent_request",
        id: sessionId,
        request: {
          type: "session.input",
          request_id: crypto.randomUUID(),
          session_id: codingAgentSessionId,
          messages: [{ id: clientMessageId, role: "user", content: text }],
        },
      });
    },
    [sessionId, store],
  );

  const handleStop = useCallback(() => {
    const codingAgentSessionId = store.getState().sessions[sessionId]?.codingAgentSessionId;
    if (!codingAgentSessionId) return;

    wsClient.send({
      type: "agent_request",
      id: sessionId,
      request: {
        type: "session.cancel",
        request_id: crypto.randomUUID(),
        session_id: codingAgentSessionId,
      },
    });
  }, [sessionId, store]);

  const handleSteer = useCallback(
    (text: string) => {
      // Steer: cancel the current run, then send a new message.
      // The cancel stops the model at the next chunk boundary. All work persisted
      // so far (user messages, completed tool results) stays in the session.
      // The new run loads the latest session state and sees that prior work as context.
      // Clear any queued message first to prevent double-send on run.cancelled.
      store.getState().setQueuedMessage(sessionId, null);
      handleStop();
      handleSend(text);
    },
    [sessionId, store, handleStop, handleSend],
  );

  const handleQueue = useCallback(
    (text: string) => {
      store.getState().setQueuedMessage(sessionId, text);
    },
    [sessionId, store],
  );

  const handleCancelQueue = useCallback(() => {
    store.getState().setQueuedMessage(sessionId, null);
  }, [sessionId, store]);

  const handleSubmitHumanInput = useCallback(
    (args: {
      runId: string;
      pendingKey: string;
      answers: Record<string, string[]>;
      freeform: Record<string, string>;
    }) => {
      const codingAgentSessionId = store.getState().sessions[sessionId]?.codingAgentSessionId;
      if (!codingAgentSessionId) return;

      wsClient.send({
        type: "agent_request",
        id: sessionId,
        request: {
          type: "human.input.response",
          request_id: crypto.randomUUID(),
          session_id: codingAgentSessionId,
          run_id: args.runId,
          pending_key: args.pendingKey,
          answers: args.answers,
          freeform: args.freeform,
        },
      });
    },
    [sessionId, store],
  );

  const handleSubmitApproval = useCallback(
    (args: { runId: string; pendingKey: string; toolName: string; decision: string }) => {
      const codingAgentSessionId = store.getState().sessions[sessionId]?.codingAgentSessionId;
      if (!codingAgentSessionId) return;

      wsClient.send({
        type: "agent_request",
        id: sessionId,
        request: {
          type: "approval.response",
          request_id: crypto.randomUUID(),
          session_id: codingAgentSessionId,
          run_id: args.runId,
          pending_key: args.pendingKey,
          tool_name: args.toolName,
          decision: args.decision,
        },
      });
    },
    [sessionId, store],
  );

  const handleRewind = useCallback(
    (timelineItemId: string) => {
      const s = store.getState().sessions[sessionId];
      const item = s?.items.find((i) => i.id === timelineItemId);
      console.log("[rewind] item", {
        timelineItemId,
        kind: item?.kind,
        messageId: item?.messageId,
        mapEntry: s?.messageIdMap[timelineItemId],
      });

      const rewindResult = store.getState().rewindToMessage(sessionId, timelineItemId);
      console.log("[rewind] result", rewindResult);
      if (!rewindResult) return;

      const codingAgentSessionId = store.getState().sessions[sessionId]?.codingAgentSessionId;
      if (!codingAgentSessionId) return;

      if (rewindResult.rewindTargetId) {
        wsClient.send({
          type: "agent_request",
          id: sessionId,
          request: {
            type: "session.resume",
            request_id: crypto.randomUUID(),
            session_id: codingAgentSessionId,
            rewind_to_message_id: rewindResult.rewindTargetId,
          },
        });
      } else {
        // First message — resume without rewind to reload from initial state
        wsClient.send({
          type: "agent_request",
          id: sessionId,
          request: {
            type: "session.resume",
            request_id: crypto.randomUUID(),
            session_id: codingAgentSessionId,
          },
        });
      }

      // Populate input draft only for user messages (edit & resend)
      if (rewindResult.messageBody) {
        setDraftText(rewindResult.messageBody);
      }

      agentLog.info("Rewinding session", {
        sessionId,
        rewindTargetId: rewindResult.rewindTargetId,
      });
    },
    [sessionId, store],
  );

  const handleFork = useCallback(
    (timelineItemId: string) => {
      const s = store.getState().sessions[sessionId];
      if (!s) return;

      const item = s.items.find((i) => i.id === timelineItemId);
      if (!item) return;

      const codingAgentSessionId = s.codingAgentSessionId;
      if (!codingAgentSessionId) return;

      const serverId = item.messageId ?? s.messageIdMap[timelineItemId];
      console.log("[fork] item", {
        timelineItemId,
        kind: item.kind,
        messageId: item.messageId,
        mapEntry: s.messageIdMap[timelineItemId],
        serverId,
      });
      if (!serverId) return;

      let forkMessageId: string;
      if (item.kind === "user") {
        // User messages: fork from the parent (exclusive — same as rewind)
        const parentId = s.branchInfo?.messages[serverId]?.parentMessageId;
        forkMessageId = parentId ?? serverId;
      } else {
        // Non-user items: fork from this point (inclusive)
        forkMessageId = serverId;
      }

      // Fork directly to a new tab
      wsClient.send({
        type: "agent_request",
        id: sessionId,
        request: {
          type: "session.fork",
          request_id: crypto.randomUUID(),
          session_id: codingAgentSessionId,
          message_id: forkMessageId,
        },
      });
      agentLog.info("Forking session to new tab", { sessionId, messageId: forkMessageId });
    },
    [sessionId, store],
  );

  const handleDraftConsumed = useCallback(() => setDraftText(null), []);

  return (
    <div className="flex h-full flex-col">
      <CodingAgentTimeline
        items={session?.items ?? []}
        todos={session?.todos ?? []}
        isReplaying={session?.isReplaying}
        status={session?.status}
        pendingHumanInput={session?.pendingHumanInput ?? null}
        pendingApproval={session?.pendingApproval ?? null}
        onSubmitHumanInput={handleSubmitHumanInput}
        onSubmitApproval={handleSubmitApproval}
        onRewind={handleRewind}
        onFork={handleFork}
      />

      <CodingAgentInput
        onSend={handleSend}
        onStop={handleStop}
        onSteer={handleSteer}
        onQueue={handleQueue}
        onCancelQueue={handleCancelQueue}
        status={session?.status ?? "starting"}
        queuedMessage={session?.queuedMessage ?? null}
        draftText={draftText}
        onDraftConsumed={handleDraftConsumed}
        inputRef={inputRef}
      />
    </div>
  );
}
