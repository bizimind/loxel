/**
 * Agent DevTools panel — passive observer of coding-agent protocol events.
 *
 * Subscribes to the same WebSocket stream as CodingAgentPanel but stores
 * raw events and derived metrics in a separate Zustand store. Does NOT
 * create or destroy agent sessions — purely read-only.
 */
import { useEffect } from "react";

import { wsClient } from "@/api/client";
import type { WsMessage } from "@/api/ws-protocol";
import { cn } from "@/lib/utils";
import type { DevToolsTab } from "@/store/agent-devtools";
import { useAgentDevToolsStore } from "@/store/agent-devtools";

import { DevToolsEventLog } from "./DevToolsEventLog";
import { DevToolsMetrics } from "./DevToolsMetrics";
import { DevToolsState } from "./DevToolsState";

const TABS: { id: DevToolsTab; label: string }[] = [
  { id: "events", label: "Events" },
  { id: "metrics", label: "Metrics" },
  { id: "state", label: "State" },
];

export function AgentDevToolsPanel({ sessionId }: { sessionId: string }) {
  const store = useAgentDevToolsStore;
  const activeTab = useAgentDevToolsStore((s) => s.sessions[sessionId]?.activeTab ?? "events");

  useEffect(() => {
    store.getState().initSession(sessionId);

    const unsub = wsClient.subscribe((msg: WsMessage) => {
      if (msg.type === "agent_event" && msg.id === sessionId) {
        store.getState().pushEvent(sessionId, msg.event, msg.seq);
      }
      // agent_exit / agent_error are handled by the main CodingAgentPanel store;
      // all other message types are ignored here.
    });

    return () => {
      unsub();
    };
  }, [sessionId, store]);

  return (
    <div className="flex h-full flex-col">
      {/* Tab bar */}
      <div className="border-b-panel flex items-center border-b">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            onClick={() => store.getState().setActiveTab(sessionId, tab.id)}
            className={cn(
              "px-3 py-1.5 text-xs font-medium transition-colors",
              activeTab === tab.id
                ? "text-foreground border-b-2 border-b-blue-500"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div className="flex-1 overflow-hidden">
        {activeTab === "events" && <DevToolsEventLog sessionId={sessionId} />}
        {activeTab === "metrics" && <DevToolsMetrics sessionId={sessionId} />}
        {activeTab === "state" && <DevToolsState sessionId={sessionId} />}
      </div>
    </div>
  );
}
