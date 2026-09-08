import type { DebugSnapshot } from "@/store/agent-devtools";
import { useAgentDevToolsStore } from "@/store/agent-devtools";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-3">
      <div className="text-muted-foreground mb-1 text-[10px] font-semibold tracking-wider uppercase">
        {title}
      </div>
      {children}
    </div>
  );
}

function KV({ label, value }: { label: string; value: string | number | boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-2 py-0.5 font-mono text-xs">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-foreground tabular-nums">{String(value)}</span>
    </div>
  );
}

function SummaryBadges({ summary }: { summary: Record<string, number> }) {
  return (
    <div className="mt-0.5 flex flex-wrap gap-1">
      {Object.entries(summary).map(([status, count]) =>
        count > 0 ? (
          <span
            key={status}
            className="bg-muted/50 text-muted-foreground rounded px-1.5 py-px text-[10px] tabular-nums"
          >
            {status}: {count}
          </span>
        ) : null,
      )}
    </div>
  );
}

function SnapshotView({ snapshot }: { snapshot: DebugSnapshot }) {
  return (
    <div className="space-y-1">
      <Section title="Counters">
        <KV label="Step" value={snapshot.stepIndex} />
        <KV label="Input Tokens" value={snapshot.totalInputTokens.toLocaleString()} />
        <KV label="Output Tokens" value={snapshot.totalOutputTokens.toLocaleString()} />
        <KV label="Reasoning Tokens" value={snapshot.totalReasoningTokens.toLocaleString()} />
      </Section>

      <Section title="Context Window">
        <KV label="Messages (total)" value={snapshot.context.messageCount} />
        <KV label="Active Chain" value={snapshot.context.activeChainLength} />
        <KV label="Branches" value={snapshot.context.branchCount} />
        <KV label="Compactions" value={snapshot.context.compactionCount} />
        <KV label="Replacement Active" value={snapshot.context.contextReplacementActive} />
      </Section>

      <Section title="Prompt Assembly">
        <KV label="Token Count" value={`~${snapshot.prompt.approxTokenCount}`} />
        <div className="text-muted-foreground mt-0.5 text-[10px]">
          Segments: {snapshot.prompt.segmentIds.join(", ") || "none"}
        </div>
        {snapshot.prompt.droppedSegmentIds.length > 0 && (
          <div className="mt-0.5 text-[10px] text-amber-400">
            Dropped: {snapshot.prompt.droppedSegmentIds.join(", ")}
          </div>
        )}
      </Section>

      <Section title="Agent State">
        <KV label="Mode" value={snapshot.agentState.mode} />
        <KV label="Profile" value={snapshot.agentState.profile} />
        {snapshot.agentState.activeReminders.length > 0 && (
          <div className="mt-0.5">
            <span className="text-muted-foreground text-[10px]">Active Reminders: </span>
            <span className="text-[10px] text-amber-400">
              {snapshot.agentState.activeReminders.join(", ")}
            </span>
          </div>
        )}
        {Object.values(snapshot.agentState.todoSummary).some((v) => v > 0) && (
          <div className="mt-1">
            <span className="text-muted-foreground text-[10px]">Todos:</span>
            <SummaryBadges summary={snapshot.agentState.todoSummary} />
          </div>
        )}
        {Object.values(snapshot.agentState.planStepSummary).some((v) => v > 0) && (
          <div className="mt-1">
            <span className="text-muted-foreground text-[10px]">Plan Steps:</span>
            <SummaryBadges summary={snapshot.agentState.planStepSummary} />
          </div>
        )}
      </Section>

      {snapshot.loopControl && (
        <Section title="Loop Control">
          <KV label="Tool Calls" value={snapshot.loopControl.toolCallCount} />
          <KV label="Detector Sequence" value={snapshot.loopControl.detectorSequenceLength} />
        </Section>
      )}
    </div>
  );
}

export function DevToolsState({ sessionId }: { sessionId: string }) {
  const snapshot = useAgentDevToolsStore((s) => s.sessions[sessionId]?.latestSnapshot ?? null);

  if (!snapshot) {
    return (
      <div className="text-muted-foreground flex h-full items-center justify-center text-xs">
        No debug snapshot yet. State updates after each model step.
      </div>
    );
  }

  return (
    <div className="h-full overflow-auto p-3">
      <SnapshotView snapshot={snapshot} />
    </div>
  );
}
