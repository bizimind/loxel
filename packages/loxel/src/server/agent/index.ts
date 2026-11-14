import type { AgentEvent } from "@/api/agent-session-model";

/**
 * Agent panels' server side: sessions, their manager, and the Claude Agent SDK transport.
 * See docs/AGENT_PANEL.md.
 */
import { isRepoTrusted, reportRepoRestriction } from "../repo-trust";
import { buildSpawnEnv } from "../shell-env";
import { AgentManager } from "./agent-manager";
import { ClaudeSdkTransport } from "./claude-sdk-transport";
import { readStartingSettings, startingEvents } from "./claude-settings";
import { claudeConfigDir, findTranscript, transcriptEvents } from "./claude-transcript";

export type { AgentClient } from "./agent-session";
export { AgentManager };

/** The manager for Claude Code sessions, driven through the user's installed `claude`. */
export function createClaudeAgentManager(loxelEnv: Record<string, string>): AgentManager {
  // The catalog the last session reported, so the next one names its models from its first frame.
  let lastCatalog: Extract<AgentEvent, { type: "catalog" }> | null = null;
  return new AgentManager({
    startingEvents: async (worktreePath) => {
      const env = buildSpawnEnv();
      const settings = await readStartingSettings(claudeConfigDir(env), worktreePath, env);
      return startingEvents(settings, lastCatalog);
    },
    createTransport: (launch, sessionHandlers) => {
      const handlers: typeof sessionHandlers = {
        ...sessionHandlers,
        onEvents: (events) => {
          for (const event of events) {
            if (event.type === "catalog" && event.models) lastCatalog = event;
          }
          sessionHandlers.onEvents(events);
        },
      };
      return new ClaudeSdkTransport(
        launch,
        (target) => {
          // Print mode, which the SDK runs, skips Claude Code's own "trust this folder" prompt, so
          // the project's hooks and settings would run unasked: Loxel's repository trust stands in.
          if (!isRepoTrusted(target.worktreePath)) {
            reportRepoRestriction(target.worktreePath, "Claude sessions don't start");
            throw new Error(
              "Trust this repository to start Claude here. Claude Code does not ask about folder trust in this mode, so Loxel does.",
            );
          }
          const env = buildSpawnEnv();
          const binary = Bun.which("claude", { PATH: env.PATH ?? "" });
          if (!binary) {
            throw new Error(
              "Claude Code (`claude`) is not on your PATH. Install it, then resume this session.",
            );
          }
          return { binary, env, loxelEnv };
        },
        handlers,
      );
    },
    loadHistory: async (sessionId) => {
      const path = await findTranscript(claudeConfigDir(buildSpawnEnv()), sessionId);
      if (!path) return null;
      return transcriptEvents(await Bun.file(path).text());
    },
  });
}
