/**
 * The session's model, effort and permission mode as compact pill menus in the composer's footer,
 * and the status line above it: what the agent is doing, for how long, and how full its context
 * is. Every value shown is the session's real one; a pill whose value is not known yet is left out
 * rather than showing "default".
 */
import { ChevronDownIcon, CircleIcon, GaugeIcon, PlayIcon, SquareTerminalIcon } from "lucide-react";
import { useEffect, useState } from "react";

import {
  AGENT_PERMISSION_MODES,
  type AgentClientMessage,
  type AgentPermissionMode,
  type AgentState,
  type AgentStatus,
  agentDisplayStatus,
  currentModel,
  isAgentPermissionMode,
  modelLabel,
  modelName,
  pickableModels,
} from "@/api/agent-session-model";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

export const MODE_LABELS: Record<AgentPermissionMode, string> = {
  default: "Ask before edits",
  acceptEdits: "Accept edits",
  plan: "Plan",
  auto: "Auto",
  dontAsk: "Don't ask",
  bypassPermissions: "Bypass permissions",
};

const MODE_HINTS: Record<AgentPermissionMode, string> = {
  default: "Asks before editing files or running commands",
  acceptEdits: "Edits files without asking; asks before commands",
  plan: "Reads and plans; changes nothing until you approve",
  auto: "A classifier approves what is safe and asks about the rest",
  dontAsk: "Runs only what your rules allow, and denies the rest",
  bypassPermissions: "Runs everything without asking",
};

const pillClass =
  "text-muted-foreground hover:text-foreground hover:bg-foreground/[0.06] data-popup-open:bg-foreground/[0.06] data-popup-open:text-foreground flex h-6 shrink-0 items-center gap-1 rounded-md px-2 text-[12px] whitespace-nowrap outline-none disabled:pointer-events-none disabled:opacity-50";

function Pill({
  label,
  title,
  disabled,
  children,
}: {
  label: string;
  title: string;
  disabled: boolean;
  children: React.ReactNode;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger className={pillClass} disabled={disabled} title={title}>
        {label}
        <ChevronDownIcon className="size-3 opacity-60" />
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" className="w-auto min-w-48">
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function AgentControls({
  state,
  send,
}: {
  state: AgentState;
  send: (message: AgentClientMessage) => boolean;
}) {
  const running = !state.handedOff && state.status !== "exited" && state.status !== "failed";
  const model = currentModel(state);
  const label = modelLabel(state);
  const effortLevels = model?.effortLevels ?? [];
  const mode = state.permissionMode;

  return (
    <>
      {label && (
        <Pill label={label} title="Model" disabled={!running}>
          <DropdownMenuGroup>
            <DropdownMenuLabel>Model</DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={model?.value ?? ""}
              onValueChange={(value: unknown) => {
                if (typeof value === "string") send({ type: "set_model", model: value });
              }}
            >
              {pickableModels(state.models).map((m) => (
                <DropdownMenuRadioItem key={m.value} value={m.value}>
                  <span className="flex flex-col">
                    <span>{modelName(m)}</span>
                    <span className="text-muted-foreground text-[11px]">
                      {m.description.split(" · ")[1] ?? m.displayName}
                    </span>
                  </span>
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuGroup>
        </Pill>
      )}
      {state.effort && effortLevels.length > 0 && (
        <Pill label={state.effort} title="Effort" disabled={!running}>
          <DropdownMenuGroup>
            <DropdownMenuLabel>Effort</DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={state.effort}
              onValueChange={(value: unknown) => {
                if (typeof value === "string") send({ type: "set_effort", effort: value });
              }}
            >
              {effortLevels.map((level) => (
                <DropdownMenuRadioItem key={level} value={level}>
                  {level}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuGroup>
        </Pill>
      )}
      {mode && (
        <Pill label={MODE_LABELS[mode]} title={MODE_HINTS[mode]} disabled={!running}>
          <DropdownMenuGroup>
            <DropdownMenuLabel>Permissions</DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={mode}
              onValueChange={(value: unknown) => {
                if (isAgentPermissionMode(value))
                  send({ type: "set_permission_mode", mode: value });
              }}
            >
              {AGENT_PERMISSION_MODES.map((m) => (
                <DropdownMenuRadioItem key={m} value={m}>
                  <span className="flex flex-col">
                    <span>{MODE_LABELS[m]}</span>
                    <span className="text-muted-foreground text-[11px]">{MODE_HINTS[m]}</span>
                  </span>
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuGroup>
        </Pill>
      )}
    </>
  );
}

/** Seconds since the current turn started working, ticking while it works. */
function useElapsed(working: boolean): number | null {
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!working) {
      setStartedAt(null);
      return;
    }
    const start = Date.now();
    setStartedAt(start);
    setNow(start);
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [working]);
  return startedAt === null ? null : Math.max(0, Math.floor((now - startedAt) / 1000));
}

function formatElapsed(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? `${m}m ${String(s).padStart(2, "0")}s` : `${s}s`;
}

const STATUS_TEXT: Record<AgentStatus, string> = {
  starting: "Starting",
  idle: "Ready",
  working: "Working",
  needs_input: "Waiting for you",
  failed: "Stopped with an error",
  exited: "Stopped",
};

export function AgentStatusLine({
  state,
  send,
  onShowRequest,
  onContinueInTerminal,
}: {
  state: AgentState;
  send: (message: AgentClientMessage) => boolean;
  onShowRequest: () => void;
  onContinueInTerminal: () => void;
}) {
  const status = agentDisplayStatus(state);
  const elapsed = useElapsed(state.status === "working");
  const stopped = state.handedOff || status === "exited" || status === "failed";

  return (
    <div className="text-muted-foreground flex h-6 items-center gap-2 px-1 text-[12px]">
      <span className="flex items-center gap-1.5">
        <CircleIcon
          className={cn(
            "size-2 fill-current",
            status === "working" && "text-ring animate-pulse",
            status === "needs_input" && "text-ring",
            status === "idle" && "text-diff-add-text",
            status === "failed" && "text-destructive",
            (status === "starting" || status === "exited") && "text-muted-foreground",
          )}
        />
        {state.handedOff ? "Continued in a terminal" : STATUS_TEXT[status]}
        {status === "working" && elapsed !== null && <span>· {formatElapsed(elapsed)}</span>}
      </span>
      {status === "needs_input" && (
        <button type="button" onClick={onShowRequest} className="text-ring hover:underline">
          Show what Claude asks
        </button>
      )}
      <span className="flex-1" />
      {state.contextUsage && (
        <button
          type="button"
          onClick={() => send({ type: "refresh_context_usage" })}
          title={`${state.contextUsage.totalTokens.toLocaleString()} of ${state.contextUsage.maxTokens.toLocaleString()} tokens (refresh)`}
          className="hover:text-foreground flex items-center gap-1"
        >
          <GaugeIcon className="size-3" /> {Math.round(state.contextUsage.percentage)}% context
        </button>
      )}
      {stopped ? (
        <Button size="xs" variant="ghost" onClick={() => send({ type: "resume" })}>
          <PlayIcon /> Resume here
        </Button>
      ) : (
        <Button
          size="xs"
          variant="ghost"
          disabled={!state.sessionId}
          onClick={onContinueInTerminal}
          title="Stop here and continue this session in a terminal, for anything this panel does not show"
        >
          <SquareTerminalIcon /> Open in terminal
        </Button>
      )}
    </div>
  );
}
