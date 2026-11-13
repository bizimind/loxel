/**
 * The agent panel: a native view of a Claude Code session the server drives. A header with the
 * session's state, model, effort and permission mode; the transcript; the cards for what the agent
 * needs from the user; and the composer. "Continue in terminal" hands the same session to the
 * `claude` TUI in a Loxel terminal for anything this view does not cover.
 */
import type { DockviewPanelApi } from "dockview-react";
import { ChevronDownIcon, PlayIcon, SquareTerminalIcon } from "lucide-react";
import { useCallback, useEffect, useRef, type ReactNode } from "react";

import {
  PERMISSION_MODE_LABELS,
  PERMISSION_MODES,
  type AgentClientMessage,
} from "@/api/agent-session-model";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { AgentPanelParams } from "@/lib/panel-creators";
import { cn } from "@/lib/utils";
import { WINDOW_ID } from "@/lib/window-id";
import { requestOpen } from "@/open-request";

import { STATUS_DOT_CLASS, STATUS_LABELS } from "./agent-status";
import { AgentComposer } from "./AgentComposer";
import { AgentInteractionCard } from "./AgentInteractions";
import { AgentTranscript } from "./AgentTranscript";
import { useAgentSession } from "./use-agent-session";

function HeaderMenu<T extends string>({
  label,
  value,
  options,
  onChange,
  disabled,
}: {
  label: ReactNode;
  value: T | null;
  options: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
  disabled?: boolean;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        disabled={disabled}
        className="text-muted-foreground hover:text-foreground hover:bg-muted flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] disabled:opacity-50"
      >
        {label}
        <ChevronDownIcon className="size-3" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-44">
        <DropdownMenuRadioGroup
          value={value ?? ""}
          onValueChange={(next) => {
            const option = options.find((o) => o.value === next);
            if (option) onChange(option.value);
          }}
        >
          {options.map((option) => (
            <DropdownMenuRadioItem key={option.value} value={option.value} closeOnClick>
              {option.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Keep the transcript pinned to the bottom while the user has not scrolled up. */
function useStickToBottom(dependency: unknown) {
  const ref = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  useEffect(() => {
    const element = ref.current;
    if (element && pinned.current) element.scrollTop = element.scrollHeight;
  }, [dependency]);
  const onScroll = useCallback(() => {
    const element = ref.current;
    if (!element) return;
    pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight < 48;
  }, []);
  return { ref, onScroll };
}

export function AgentPanel({
  params,
  panelApi,
}: {
  params: AgentPanelParams;
  panelApi: DockviewPanelApi;
}) {
  const { agentId, worktreePath, sessionId, handedOff } = params;
  const paramsRef = useRef(params);
  paramsRef.current = params;
  const updateParams = useCallback(
    (patch: Partial<AgentPanelParams>) =>
      panelApi.updateParameters({ ...paramsRef.current, ...patch }),
    [panelApi],
  );
  const onSessionId = useCallback((id: string) => updateParams({ sessionId: id }), [updateParams]);
  const onHandedOff = useCallback(
    (command: string, cwd: string) => {
      void requestOpen(window.location.origin, {
        terminal: { cwd, command, title: "Claude" },
        pinWtPath: worktreePath,
        windowId: WINDOW_ID,
      });
    },
    [worktreePath],
  );

  const { snapshot, connected, send } = useAgentSession({
    agentId,
    cwd: worktreePath,
    sessionId,
    handedOff,
    onSessionId,
    onHandedOff,
  });
  const { status, info, items, interactions } = snapshot;

  // Remember a hand-off across restarts, so a restored panel waits instead of running the session
  // beside the terminal's `claude --resume`.
  useEffect(() => {
    if (status === "handed_off" && !paramsRef.current.handedOff) updateParams({ handedOff: true });
    if ((status === "idle" || status === "working") && paramsRef.current.handedOff) {
      updateParams({ handedOff: false });
    }
  }, [status, updateParams]);
  const running = status !== "failed" && status !== "handed_off" && status !== "starting";
  const command = useCallback((message: AgentClientMessage) => send(message), [send]);
  // Follows text streaming into the last item too, not only new items.
  const last = items.at(-1);
  const lastLength = last && "text" in last ? last.text.length : 0;
  const { ref: scrollRef, onScroll } = useStickToBottom(
    `${items.length}:${interactions.length}:${lastLength}`,
  );

  // The agent reports its model by id; the list names models by alias with the id they stand for.
  const currentModel = info.models.find(
    (m) => m.value === info.model || (m.resolvedModel && m.resolvedModel === info.model),
  );
  const effortLevels = (currentModel ?? info.models[0])?.effortLevels ?? [];

  return (
    <div className="bg-editor-surface flex h-full min-h-0 flex-col">
      <div className="border-border flex h-8 shrink-0 items-center gap-1 border-b px-2">
        <span className="flex items-center gap-1.5 pr-1 text-[11px]">
          <span className={cn("size-2 rounded-full", STATUS_DOT_CLASS[status])} />
          <span className="text-foreground">
            {connected ? STATUS_LABELS[status] : "Reconnecting…"}
          </span>
        </span>
        <HeaderMenu
          label={currentModel?.displayName ?? info.model ?? "Model"}
          value={currentModel?.value ?? info.model}
          options={info.models.map((m) => ({ value: m.value, label: m.displayName }))}
          onChange={(model) => command({ type: "set_model", model })}
          disabled={!running}
        />
        {effortLevels.length > 0 && (
          <HeaderMenu
            label={`Effort: ${info.effort ?? "default"}`}
            value={info.effort}
            options={effortLevels.map((e) => ({ value: e, label: e }))}
            onChange={(effort) => command({ type: "set_effort", effort })}
            disabled={!running}
          />
        )}
        <HeaderMenu
          label={PERMISSION_MODE_LABELS[info.permissionMode]}
          value={info.permissionMode}
          options={PERMISSION_MODES.map((m) => ({ value: m, label: PERMISSION_MODE_LABELS[m] }))}
          onChange={(mode) => command({ type: "set_permission_mode", mode })}
          disabled={!running}
        />
        <span className="ml-auto flex items-center gap-2">
          {info.costUsd !== null && (
            <span className="text-muted-foreground text-[11px]" title="Cost of this session so far">
              ${info.costUsd.toFixed(2)}
            </span>
          )}
          {info.agentVersion && (
            <span className="text-muted-foreground text-[11px]">
              Claude Code {info.agentVersion}
            </span>
          )}
          <Button
            size="xs"
            variant="ghost"
            disabled={!info.sessionId || status === "handed_off"}
            title="Continue this conversation in the Claude Code terminal UI"
            onClick={() => command({ type: "hand_off" })}
          >
            <SquareTerminalIcon />
            Continue in terminal
          </Button>
        </span>
      </div>

      <div ref={scrollRef} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-[860px] flex-col px-8 py-6">
          {items.length === 0 && status !== "failed" && (
            <div className="text-muted-foreground py-16 text-center text-sm">
              {status === "starting"
                ? "Starting Claude Code…"
                : `Claude Code in ${info.cwd.split("/").pop() ?? info.cwd}. Ask anything, or type / for commands and skills.`}
            </div>
          )}
          <AgentTranscript items={items} />
        </div>
      </div>

      <div className="mx-auto flex w-full max-w-[860px] shrink-0 flex-col gap-2 px-8 pb-4">
        {interactions.map((interaction) => (
          <AgentInteractionCard
            key={interaction.id}
            interaction={interaction}
            respond={(response) =>
              command({ type: "respond", interactionId: interaction.id, response })
            }
          />
        ))}
        {(status === "handed_off" || status === "failed") && (
          <div className="border-border bg-background flex items-center gap-3 rounded-lg border px-3.5 py-2.5 text-xs">
            <span className="text-muted-foreground flex-1">
              {status === "handed_off"
                ? "This conversation continues in a terminal. Resume it here when you are done there; exit Claude Code in the terminal first."
                : (info.error ?? "Claude Code stopped.")}
            </span>
            {status === "failed" && info.sessionId && (
              <Button
                size="sm"
                variant="ghost"
                title="Start a new conversation instead of resuming this one"
                onClick={() => command({ type: "resume", fresh: true })}
              >
                New conversation
              </Button>
            )}
            <Button size="sm" onClick={() => command({ type: "resume" })}>
              <PlayIcon />
              {info.sessionId ? "Resume here" : "Start again"}
            </Button>
          </div>
        )}
        <AgentComposer
          commands={info.commands}
          working={status === "working" || status === "needs_input"}
          disabled={!running || !connected}
          onSend={(text, images, delivery) => command({ type: "send", text, images, delivery })}
          onInterrupt={() => command({ type: "interrupt" })}
        />
      </div>
    </div>
  );
}
