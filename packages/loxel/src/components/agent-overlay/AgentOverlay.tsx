import { useQuery } from "@tanstack/react-query";
import type { DockviewPanelApi } from "dockview-react";
import {
  ArrowUpIcon,
  ChevronDownIcon,
  Loader2Icon,
  SquareIcon,
  SquareTerminalIcon,
} from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import type {
  AgentAction,
  AgentCommand,
  AgentPermissionMode,
  AgentSessionSummary,
} from "@/api/agent-overlay-model";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { usePanelActivationFocus } from "@/hooks/usePanelActivationFocus";
import { cn } from "@/lib/utils";
import {
  fetchAgentCatalog,
  performAgentAction,
  subscribeAgentTranscript,
  useAgentOverlayStore,
} from "@/store/agent-overlay";

import { AgentInteractionCard } from "./AgentInteractionCard";
import { AgentStateDot } from "./AgentStateDot";
import { AgentTranscript } from "./AgentTranscript";

const MODE_LABELS: Record<AgentPermissionMode, string> = {
  default: "Ask before edits",
  acceptEdits: "Accept edits",
  plan: "Plan mode",
  auto: "Auto mode",
  bypassPermissions: "Bypass permissions",
  dontAsk: "Don't ask",
};

const STATE_LABELS: Record<AgentSessionSummary["state"], string> = {
  working: "Working",
  "needs-input": "Needs input",
  idle: "Idle",
  failed: "Failed",
  ended: "Ended",
};

interface AgentOverlayProps {
  terminalId: string;
  panelApi: DockviewPanelApi;
  onShowTerminal: () => void;
}

/**
 * The rich view of a Claude Code session running in a terminal: its transcript, the interaction it
 * waits on, and a composer, all acting on the same process the terminal shows.
 */
export function AgentOverlay({ terminalId, panelApi, onShowTerminal }: AgentOverlayProps) {
  const session = useAgentOverlayStore((s) => s.sessions[terminalId]);
  const items = useAgentOverlayStore((s) => s.transcripts[terminalId]);
  const composerRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => subscribeAgentTranscript(terminalId), [terminalId]);
  usePanelActivationFocus(
    panelApi,
    useCallback(() => composerRef.current?.focus(), []),
  );

  if (!session) return null;
  return (
    <div className="bg-editor-surface flex h-full min-h-0 flex-col">
      <AgentHeader session={session} onShowTerminal={onShowTerminal} />
      <TranscriptScroller session={session} items={items ?? []} />
      <div className="mx-auto w-full max-w-[860px] space-y-2 px-6 pb-4">
        <AgentInteractionCard session={session} onShowTerminal={onShowTerminal} />
        {session.error && (
          <div className="rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-300">
            {session.error}
          </div>
        )}
        <AgentComposer session={session} inputRef={composerRef} />
      </div>
    </div>
  );
}

function AgentHeader({
  session,
  onShowTerminal,
}: {
  session: AgentSessionSummary;
  onShowTerminal: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const act = async (action: AgentAction) => {
    setError(null);
    try {
      const result = await performAgentAction(session.terminalId, action);
      if (!result.ok) setError(result.error);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };
  return (
    <div className="border-border flex h-9 shrink-0 items-center gap-2 border-b px-3 text-xs">
      <AgentStateDot state={session.state} />
      <span className="text-muted-foreground">{STATE_LABELS[session.state]}</span>
      <span className="text-foreground min-w-0 truncate font-medium">
        {session.title ?? "Claude Code"}
      </span>
      <div className="ml-auto flex shrink-0 items-center gap-1">
        {error && (
          <span className="max-w-64 truncate text-red-400" title={error}>
            {error}
          </span>
        )}
        <ModelMenu session={session} onAction={act} />
        <DropdownMenu>
          <DropdownMenuTrigger className="text-muted-foreground hover:text-foreground hover:bg-muted flex items-center gap-1 rounded px-1.5 py-0.5">
            {session.permissionMode ? MODE_LABELS[session.permissionMode] : "Mode"}
            <ChevronDownIcon className="size-3" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuGroup>
              <DropdownMenuLabel>Permission mode (Shift+Tab)</DropdownMenuLabel>
              {(["default", "acceptEdits", "plan", "auto"] as const).map((mode) => (
                <DropdownMenuItem key={mode} onClick={() => void act({ type: "mode", mode })}>
                  {MODE_LABELS[mode]}
                </DropdownMenuItem>
              ))}
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
        <Button
          size="xs"
          variant="ghost"
          onClick={onShowTerminal}
          title="Show the terminal (the same Claude session)"
        >
          <SquareTerminalIcon className="size-3.5" />
          Terminal
        </Button>
      </div>
    </div>
  );
}

function ModelMenu({
  session,
  onAction,
}: {
  session: AgentSessionSummary;
  onAction: (action: AgentAction) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const catalog = useQuery({
    queryKey: ["agent-catalog", session.terminalId],
    queryFn: () => fetchAgentCatalog(session.terminalId),
    enabled: open,
    staleTime: 5 * 60_000,
  });
  const efforts = catalog.data?.models.find((model) => model.value === "default")?.efforts ?? [];
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger className="text-muted-foreground hover:text-foreground hover:bg-muted flex items-center gap-1 rounded px-1.5 py-0.5">
        {session.model ?? "Model"}
        {session.effort && <span className="opacity-70">· {session.effort}</span>}
        <ChevronDownIcon className="size-3" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-w-80">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Model</DropdownMenuLabel>
          {catalog.isLoading && (
            <div className="text-muted-foreground px-2 py-1.5 text-xs">Asking Claude…</div>
          )}
          {catalog.data?.models.map((model) => (
            <DropdownMenuItem
              key={model.value}
              onClick={() => void onAction({ type: "model", model: model.value })}
            >
              <div className="flex min-w-0 flex-col">
                <span>{model.displayName}</span>
                <span className="text-muted-foreground truncate text-[11px]">
                  {model.description}
                </span>
              </div>
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
        {efforts.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuLabel>Effort</DropdownMenuLabel>
              {efforts.map((effort) => (
                <DropdownMenuItem
                  key={effort}
                  onClick={() => void onAction({ type: "effort", effort })}
                >
                  {effort}
                </DropdownMenuItem>
              ))}
            </DropdownMenuGroup>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Keeps the newest message in view unless the user scrolled up to read. */
function TranscriptScroller({
  session,
  items,
}: {
  session: AgentSessionSummary;
  items: Parameters<typeof AgentTranscript>[0]["items"];
}) {
  const ref = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  useLayoutEffect(() => {
    const element = ref.current;
    if (element && pinned.current) element.scrollTop = element.scrollHeight;
  }, [items, session.state, session.interaction]);
  return (
    <div
      ref={ref}
      className="min-h-0 flex-1 overflow-y-auto"
      onScroll={(event) => {
        const element = event.currentTarget;
        pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight < 40;
      }}
    >
      <div className="mx-auto w-full max-w-[860px] px-6 py-6">
        {items.length === 0 ? (
          <div className="text-muted-foreground py-16 text-center text-sm">
            Claude Code is running in this terminal. Send a message to start.
          </div>
        ) : (
          <AgentTranscript items={items} cwd={session.cwd} home={session.homeDir} />
        )}
        {session.state === "working" && (
          <div className="text-muted-foreground mt-4 flex items-center gap-2 px-2 text-[13px]">
            <Loader2Icon className="size-3.5 animate-spin" />
            Working…
          </div>
        )}
      </div>
    </div>
  );
}

function matchCommands(commands: AgentCommand[], text: string): AgentCommand[] {
  const query = text.slice(1).split(/\s/u)[0]?.toLowerCase() ?? "";
  return commands
    .filter((command) => command.name.slice(1).toLowerCase().includes(query))
    .sort(
      (a, b) =>
        Number(!a.name.slice(1).toLowerCase().startsWith(query)) -
        Number(!b.name.slice(1).toLowerCase().startsWith(query)),
    )
    .slice(0, 50);
}

function AgentComposer({
  session,
  inputRef,
}: {
  session: AgentSessionSummary;
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
}) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const slash = text.startsWith("/") && !text.includes("\n") && !/\s/u.test(text.trim().slice(1));
  const catalog = useQuery({
    queryKey: ["agent-catalog", session.terminalId],
    queryFn: () => fetchAgentCatalog(session.terminalId),
    enabled: slash,
    staleTime: 5 * 60_000,
  });
  const matches = useMemo(
    () => (slash && catalog.data ? matchCommands(catalog.data.commands, text) : []),
    [slash, catalog.data, text],
  );
  const working = session.state === "working";
  const blocked = session.interaction !== null;

  const send = async (value: string) => {
    const prompt = value.trim();
    if (!prompt || sending) return;
    setSending(true);
    setError(null);
    try {
      const result = await performAgentAction(session.terminalId, { type: "prompt", text: prompt });
      if (result.ok) setText("");
      else setError(result.error);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="relative">
      {matches.length > 0 && (
        <div className="border-border bg-popover absolute right-0 bottom-full left-0 mb-2 max-h-72 overflow-y-auto rounded-lg border py-1 shadow-lg">
          {matches.map((command, index) => (
            <button
              key={command.name}
              type="button"
              className={cn(
                "flex w-full items-baseline gap-3 px-3 py-1.5 text-left",
                index === highlight ? "bg-muted" : "hover:bg-muted/60",
              )}
              onMouseEnter={() => setHighlight(index)}
              onClick={() => setText(`${command.name} `)}
            >
              <span className="text-foreground shrink-0 font-mono text-[13px]">{command.name}</span>
              <span className="text-muted-foreground truncate text-xs">{command.description}</span>
            </button>
          ))}
        </div>
      )}
      <div
        className={cn(
          "border-border bg-surface-1 focus-within:border-primary/70 flex items-end gap-2 rounded-xl border px-3 py-2 transition-colors",
          blocked && "opacity-60",
        )}
      >
        <textarea
          ref={inputRef}
          data-agent-composer=""
          className="placeholder:text-muted-foreground max-h-60 min-h-6 flex-1 resize-none bg-transparent py-1 text-[15px] leading-6 outline-none"
          rows={Math.min(8, Math.max(1, text.split("\n").length))}
          placeholder={
            blocked
              ? "Answer Claude above first"
              : working
                ? "Queue a message for Claude…"
                : "Message Claude — / for commands"
          }
          value={text}
          disabled={blocked}
          onChange={(event) => {
            setText(event.target.value);
            setHighlight(0);
          }}
          onKeyDown={(event) => {
            if (matches.length > 0 && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
              event.preventDefault();
              const step = event.key === "ArrowDown" ? 1 : -1;
              setHighlight((at) => (at + step + matches.length) % matches.length);
              return;
            }
            if (matches.length > 0 && event.key === "Tab") {
              event.preventDefault();
              setText(`${matches[highlight]?.name ?? text} `);
              return;
            }
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              const command = matches[highlight];
              void send(command && text.trim() !== command.name ? command.name : text);
            }
          }}
        />
        {working && (
          <Button
            size="icon-sm"
            variant="ghost"
            title="Interrupt (Esc in the terminal)"
            onClick={() => void performAgentAction(session.terminalId, { type: "interrupt" })}
          >
            <SquareIcon className="size-3.5 fill-current" />
          </Button>
        )}
        <Button
          size="icon-sm"
          disabled={sending || blocked || text.trim().length === 0}
          title={working ? "Queue" : "Send"}
          onClick={() => void send(text)}
        >
          {sending ? (
            <Loader2Icon className="size-4 animate-spin" />
          ) : (
            <ArrowUpIcon className="size-4" />
          )}
        </Button>
      </div>
      {error && <div className="mt-1.5 px-1 text-xs text-red-400">{error}</div>}
    </div>
  );
}
