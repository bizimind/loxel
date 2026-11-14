/**
 * Connects an agent panel to its server session over `/ws/agent`: attaches, folds the events the
 * server sends into the same {@link AgentState} the server keeps, and reconnects after a dropped
 * socket or a server restart, resuming with the last sequence number it applied (or, against a
 * restarted server, the agent session id, which brings the conversation back from its transcript).
 */
import { useCallback, useEffect, useRef, useState } from "react";

import {
  type AgentClientMessage,
  type AgentServerMessage,
  type AgentState,
  applyAgentEvent,
  INITIAL_AGENT_STATE,
} from "@/api/agent-session-model";
import { isRecord } from "@/lib/is-record";

const RECONNECT_MS = [250, 500, 1000, 2000, 4000];

export function agentSocketUrl(agentId: string): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/ws/agent?id=${encodeURIComponent(agentId)}`;
}

function parseServerMessage(data: unknown): AgentServerMessage | null {
  if (typeof data !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(data);
    // The server is this app's own; the shape is checked only as far as routing needs.
    return isRecord(parsed) && typeof parsed.type === "string"
      ? (parsed as AgentServerMessage)
      : null;
  } catch {
    return null;
  }
}

export interface AgentSessionTarget {
  agentId: string;
  worktreePath: string;
  /** The agent session the panel showed before, kept in its params across restarts. */
  sessionId?: string;
}

export interface AgentSessionHandle {
  state: AgentState;
  connected: boolean;
  /** The last error the server reported for a request, until the next one succeeds. */
  error: string | null;
  /** Sends a message; false when the socket is not connected (the error says so). */
  send: (message: AgentClientMessage) => boolean;
  clearError: () => void;
}

export function useAgentSession(target: AgentSessionTarget): AgentSessionHandle {
  const [state, setState] = useState<AgentState>(INITIAL_AGENT_STATE);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const seqRef = useRef<number | undefined>(undefined);
  const instanceRef = useRef<string | undefined>(undefined);
  const sessionIdRef = useRef(target.sessionId);
  const { agentId, worktreePath } = target;

  useEffect(() => {
    sessionIdRef.current = target.sessionId ?? sessionIdRef.current;
  }, [target.sessionId]);

  useEffect(() => {
    let disposed = false;
    let attempt = 0;
    let retry: ReturnType<typeof setTimeout> | null = null;

    const connect = () => {
      const ws = new WebSocket(agentSocketUrl(agentId));
      wsRef.current = ws;
      ws.onopen = () => {
        attempt = 0;
        setConnected(true);
        const attach: AgentClientMessage = {
          type: "attach",
          worktreePath,
          ...(sessionIdRef.current ? { resumeSessionId: sessionIdRef.current } : {}),
          ...(seqRef.current !== undefined && instanceRef.current
            ? { sinceSeq: seqRef.current, instanceId: instanceRef.current }
            : {}),
        };
        ws.send(JSON.stringify(attach));
      };
      ws.onmessage = (event) => {
        const message = parseServerMessage(event.data);
        if (!message) return;
        if (message.type === "error") {
          setError(message.message);
          return;
        }
        if (message.type === "snapshot") {
          seqRef.current = message.seq;
          instanceRef.current = message.instanceId;
          sessionIdRef.current = message.state.sessionId ?? sessionIdRef.current;
          setState(message.state);
          return;
        }
        // An event at or below what was applied is a duplicate from a replay.
        if (seqRef.current !== undefined && message.seq <= seqRef.current) return;
        seqRef.current = message.seq;
        setState((prev) => applyAgentEvent(prev, message.event));
      };
      ws.onclose = () => {
        if (wsRef.current === ws) wsRef.current = null;
        setConnected(false);
        if (disposed) return;
        const delay = RECONNECT_MS[Math.min(attempt, RECONNECT_MS.length - 1)];
        attempt += 1;
        retry = setTimeout(connect, delay);
      };
    };
    connect();

    return () => {
      disposed = true;
      if (retry) clearTimeout(retry);
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, [agentId, worktreePath]);

  const send = useCallback((message: AgentClientMessage) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      setError("Not connected to the Loxel server");
      return false;
    }
    setError(null);
    ws.send(JSON.stringify(message));
    return true;
  }, []);

  const clearError = useCallback(() => setError(null), []);

  return { state, connected, error, send, clearError };
}

/** Ends a closed panel's session on the server, which keeps it while no panel is attached. */
export function destroyAgentSession(agentId: string): void {
  const ws = new WebSocket(agentSocketUrl(agentId));
  ws.onopen = () => {
    ws.send(JSON.stringify({ type: "destroy" } satisfies AgentClientMessage));
    ws.close();
  };
}
