import { create } from "zustand";

import { type AgentTerminalsState, EMPTY_AGENT_TERMINALS_STATE } from "@/api/agent-terminal-model";

/** A mirror of the server's agents' terminals; the server sends it on connect and every change. */
export const useAgentTerminalsStore = create<AgentTerminalsState>()(
  () => EMPTY_AGENT_TERMINALS_STATE,
);
