import { useAgentDevToolsStore } from "@/store/agent-devtools";

function formatNumber(n: number): string {
  return n.toLocaleString();
}

function formatCost(n: number | null): string {
  if (n === null) return "-";
  return `$${n.toFixed(4)}`;
}

function formatLatency(ms: number | null): string {
  if (ms === null) return "-";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="bg-muted/30 rounded-md px-3 py-2">
      <div className="text-muted-foreground text-[10px] tracking-wide uppercase">{label}</div>
      <div className="text-foreground mt-0.5 text-lg leading-tight font-semibold tabular-nums">
        {value}
      </div>
      {sub && <div className="text-muted-foreground mt-0.5 text-[10px] tabular-nums">{sub}</div>}
    </div>
  );
}

export function DevToolsMetrics({ sessionId }: { sessionId: string }) {
  const currentRunMetrics = useAgentDevToolsStore(
    (s) => s.sessions[sessionId]?.currentRunMetrics ?? null,
  );
  const completedRunMetrics = useAgentDevToolsStore(
    (s) => s.sessions[sessionId]?.completedRunMetrics ?? null,
  );
  const totalRuns = useAgentDevToolsStore((s) => s.sessions[sessionId]?.totalRuns ?? 0);
  const compactionCount = useAgentDevToolsStore((s) => s.sessions[sessionId]?.compactionCount ?? 0);

  // Use completed metrics when available, otherwise show live accumulation
  const metrics = completedRunMetrics ?? currentRunMetrics;
  const isLive = !completedRunMetrics && currentRunMetrics !== null;

  return (
    <div className="flex h-full flex-col overflow-auto p-3">
      <div className="text-muted-foreground mb-2 flex items-center gap-2 text-xs">
        <span className="font-medium">Run Metrics</span>
        {isLive && (
          <span className="rounded bg-green-500/20 px-1.5 py-px text-[10px] text-green-400">
            live
          </span>
        )}
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        <StatCard label="Input Tokens" value={formatNumber(metrics?.inputTokens ?? 0)} />
        <StatCard label="Output Tokens" value={formatNumber(metrics?.outputTokens ?? 0)} />
        <StatCard label="Reasoning Tokens" value={formatNumber(metrics?.reasoningTokens ?? 0)} />
        <StatCard label="Cost" value={formatCost(metrics?.estimatedCostUsd ?? null)} />
        <StatCard label="Model Steps" value={formatNumber(metrics?.modelStepCount ?? 0)} />
        <StatCard
          label="Tool Calls"
          value={metrics?.toolCallCount !== null ? formatNumber(metrics?.toolCallCount ?? 0) : "-"}
        />
        <StatCard label="Latency" value={formatLatency(metrics?.latencyMsTotal ?? null)} />
        <StatCard label="Runs Completed" value={formatNumber(totalRuns)} />
        <StatCard label="Compactions" value={formatNumber(compactionCount)} />
      </div>
    </div>
  );
}
