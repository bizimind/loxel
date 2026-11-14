import { create } from "zustand";

import type { AgentStatus } from "@/api/agent-session-model";

/** Each mounted agent panel's status, by panel agent id, for its tab. */
export const useAgentStatusStore = create<{
  statuses: Readonly<Record<string, AgentStatus>>;
  setStatus(agentId: string, status: AgentStatus): void;
  remove(agentId: string): void;
}>((set) => ({
  statuses: {},
  setStatus: (agentId, status) =>
    set((s) =>
      s.statuses[agentId] === status ? s : { statuses: { ...s.statuses, [agentId]: status } },
    ),
  remove: (agentId) =>
    set((s) => {
      const { [agentId]: _removed, ...rest } = s.statuses;
      return { statuses: rest };
    }),
}));
