/**
 * The renderer's mirror of the agent overlay: every agent session the server knows (for tabs) and
 * the transcripts of the terminals a mounted overlay subscribed to. Fed by ws-bridge.ts; never
 * persisted, since the server sends it all again on connect.
 */
import { create } from "zustand";

import type {
  AgentAction,
  AgentActionResult,
  AgentCatalog,
  AgentOverlayServerMessage,
  AgentSessionSummary,
  AgentTranscriptItem,
} from "@/api/agent-overlay-model";
import { fetchJson, wsClient } from "@/api/client";
import { WINDOW_ID } from "@/lib/window-id";

interface AgentOverlayState {
  sessions: Record<string, AgentSessionSummary>;
  /** Items in first-seen order, per subscribed terminal. */
  transcripts: Record<string, AgentTranscriptItem[]>;
}

export const useAgentOverlayStore = create<AgentOverlayState>(() => ({
  sessions: {},
  transcripts: {},
}));

function upsert(
  items: AgentTranscriptItem[],
  updates: AgentTranscriptItem[],
): AgentTranscriptItem[] {
  const next = [...items];
  const index = new Map(next.map((item, at) => [item.id, at]));
  for (const update of updates) {
    const at = index.get(update.id);
    if (at === undefined) {
      index.set(update.id, next.length);
      next.push(update);
    } else {
      next[at] = update;
    }
  }
  return next;
}

export function applyAgentOverlayMessage(message: AgentOverlayServerMessage): void {
  switch (message.type) {
    case "agent_sessions_sync":
      useAgentOverlayStore.setState({
        sessions: Object.fromEntries(
          message.sessions.map((session) => [session.terminalId, session]),
        ),
      });
      return;
    case "agent_session":
      useAgentOverlayStore.setState((state) => {
        const sessions = { ...state.sessions };
        if (message.session) {
          sessions[message.terminalId] = message.session;
          return { sessions };
        }
        delete sessions[message.terminalId];
        const { [message.terminalId]: _gone, ...transcripts } = state.transcripts;
        return { sessions, transcripts };
      });
      return;
    case "agent_transcript":
      useAgentOverlayStore.setState((state) => ({
        transcripts: {
          ...state.transcripts,
          [message.terminalId]: message.reset
            ? message.items
            : upsert(state.transcripts[message.terminalId] ?? [], message.items),
        },
      }));
      return;
    default: {
      const unknown: never = message;
      throw new Error(`Unknown agent overlay message ${JSON.stringify(unknown)}`);
    }
  }
}

/** Follows a terminal's transcript while the returned function is not called. */
export function subscribeAgentTranscript(terminalId: string): () => void {
  wsClient.send({ type: "agent_subscribe", terminalId });
  // A reconnect lands on a server that forgot the subscription.
  const offReconnect = wsClient.onReconnect(() =>
    wsClient.send({ type: "agent_subscribe", terminalId }),
  );
  return () => {
    offReconnect();
    wsClient.send({ type: "agent_unsubscribe", terminalId });
    useAgentOverlayStore.setState((state) => {
      const { [terminalId]: _dropped, ...transcripts } = state.transcripts;
      return { transcripts };
    });
  };
}

export function performAgentAction(
  terminalId: string,
  action: AgentAction,
): Promise<AgentActionResult> {
  return fetchJson<AgentActionResult>("/agent-overlay/action", {
    method: "POST",
    body: JSON.stringify({ terminalId, action }),
  });
}

export function fetchAgentCatalog(terminalId: string): Promise<AgentCatalog> {
  return fetchJson<AgentCatalog>(
    `/agent-overlay/catalog?terminalId=${encodeURIComponent(terminalId)}`,
  );
}

/** The command line that starts Claude Code with the overlay's hooks. */
export async function fetchClaudeLaunchCommand(): Promise<string> {
  return (await fetchJson<{ command: string }>("/agent-overlay/launch")).command;
}

/**
 * Opens a terminal in `worktreePath` running Claude Code with the overlay's hooks, the way
 * `loxel terminal` does, so the overlay sees the session from its first hook.
 */
export async function launchClaudeTerminal(worktreePath: string): Promise<void> {
  const command = await fetchClaudeLaunchCommand();
  await fetchJson("/open", {
    method: "POST",
    body: JSON.stringify({
      terminal: { cwd: worktreePath, command, title: "Claude Code" },
      pinWtPath: worktreePath,
      windowId: WINDOW_ID,
    }),
  });
}
