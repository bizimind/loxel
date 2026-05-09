/**
 * Hook to track which coding agent session is active in the center dockview.
 * Returns the session ID when an agent panel is the active center panel.
 */
import { useEffect, useState } from "react";

import { getCenterApi } from "@/store/tools-bar";

export function useActiveAgentSession(): string | null {
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);

  useEffect(() => {
    const api = getCenterApi();
    if (!api) return;

    const update = () => {
      const panel = api.activePanel;
      if (panel && panel.id.startsWith("agent-")) {
        const params = panel.params;
        const sessionId =
          typeof params === "object" && params !== null
            ? (params as Record<string, unknown>).sessionId
            : undefined;
        setActiveSessionId(typeof sessionId === "string" ? sessionId : null);
      } else {
        setActiveSessionId(null);
      }
    };

    update();
    const disposable = api.onDidActivePanelChange(update);
    return () => disposable.dispose();
  }, []);

  return activeSessionId;
}
