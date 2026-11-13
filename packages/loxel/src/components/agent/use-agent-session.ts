/**
 * The agent panel's connection to its server session over `/ws/agent`: attaches on connect,
 * applies the server's messages to a local snapshot, and reconnects with backoff. A reconnect
 * after a server restart names the agent session to resume, so the conversation continues.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { create } from "zustand";

import {
  applyAgentMessage,
  emptyAgentSnapshot,
  type AgentClientMessage,
  type AgentServerMessage,
  type AgentSnapshot,
  type AgentStatus,
} from "@/api/agent-session-model";

/** Each agent panel's status, for its tab. */
export const useAgentStatusStore = create<{
  statuses: Record<string, AgentStatus>;
  set: (agentId: string, status: AgentStatus | null) => void;
}>((set) => ({
  statuses: {},
  set: (agentId, status) =>
    set((state) => {
      const statuses = { ...state.statuses };
      if (status) statuses[agentId] = status;
      else delete statuses[agentId];
      return { statuses };
    }),
}));

const RECONNECT_MIN_MS = 500;
const RECONNECT_MAX_MS = 10_000;

function parseServerMessage(data: unknown): AgentServerMessage | null {
  if (typeof data !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(data);
    // The server is this app's own process; its messages are the shared model.
    if (typeof parsed === "object" && parsed !== null && "type" in parsed) {
      return parsed as AgentServerMessage;
    }
  } catch {
    // Not JSON: ignore.
  }
  return null;
}

export interface UseAgentSessionOptions {
  agentId: string;
  cwd: string;
  /** The agent session to resume if the server has no live session for this panel. */
  sessionId?: string;
  /** The panel was last handed off to a terminal: the server must not start it on attach. */
  handedOff?: boolean;
  onSessionId: (sessionId: string) => void;
  onHandedOff: (command: string, cwd: string) => void;
}

export function useAgentSession({
  agentId,
  cwd,
  sessionId,
  handedOff,
  onSessionId,
  onHandedOff,
}: UseAgentSessionOptions) {
  const [snapshot, setSnapshot] = useState<AgentSnapshot>(() => emptyAgentSnapshot(cwd));
  const [connected, setConnected] = useState(false);
  const socketRef = useRef<WebSocket | null>(null);
  const sessionIdRef = useRef(sessionId);
  const handedOffRef = useRef(handedOff);
  handedOffRef.current = handedOff;
  const callbacks = useRef({ onSessionId, onHandedOff });
  callbacks.current = { onSessionId, onHandedOff };

  useEffect(() => {
    let disposed = false;
    let retryMs = RECONNECT_MIN_MS;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    const connect = () => {
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const ws = new WebSocket(`${protocol}//${window.location.host}/ws/agent`);
      socketRef.current = ws;
      ws.addEventListener("open", () => {
        retryMs = RECONNECT_MIN_MS;
        const attach: AgentClientMessage = {
          type: "attach",
          agentId,
          cwd,
          ...(sessionIdRef.current ? { resumeSessionId: sessionIdRef.current } : {}),
          ...(handedOffRef.current ? { handedOff: true } : {}),
        };
        ws.send(JSON.stringify(attach));
      });
      ws.addEventListener("message", (event) => {
        const message = parseServerMessage(event.data);
        if (!message) return;
        // Usable once attached: messages sent before the snapshot would reach no session.
        if (message.type === "snapshot") setConnected(true);
        if (message.type === "handed_off")
          callbacks.current.onHandedOff(message.command, message.cwd);
        setSnapshot((current) => {
          const next = applyAgentMessage(current, message);
          const id = next.info.sessionId;
          if (id && id !== sessionIdRef.current) {
            sessionIdRef.current = id;
            queueMicrotask(() => callbacks.current.onSessionId(id));
          }
          return next;
        });
      });
      ws.addEventListener("close", () => {
        if (socketRef.current === ws) socketRef.current = null;
        setConnected(false);
        if (disposed) return;
        retryTimer = setTimeout(connect, retryMs);
        retryMs = Math.min(retryMs * 2, RECONNECT_MAX_MS);
      });
    };
    connect();

    return () => {
      disposed = true;
      if (retryTimer) clearTimeout(retryTimer);
      socketRef.current?.close();
      socketRef.current = null;
    };
  }, [agentId, cwd]);

  useEffect(() => {
    useAgentStatusStore.getState().set(agentId, snapshot.status);
  }, [agentId, snapshot.status]);
  useEffect(() => () => useAgentStatusStore.getState().set(agentId, null), [agentId]);

  const send = useCallback((message: AgentClientMessage) => {
    const ws = socketRef.current;
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
  }, []);

  return { snapshot, connected, send };
}
