/**
 * What the agent waits on the user for: a tool permission, a question (AskUserQuestion) or a plan
 * to approve (ExitPlanMode). They are the transcript's only raised surfaces, in the one accent
 * colour, drawn where the agent asked, with numbered choices: 1–9 pick while the card has focus,
 * Enter submits a question. Nothing takes focus on its own, so a card that appears while the user
 * types never catches a stray key as an answer.
 */
import { CheckIcon, FileTextIcon } from "lucide-react";
import { useState } from "react";

import type {
  AgentPermissionMode,
  AgentRequest,
  AgentResponse,
  PermissionDestination,
} from "@/api/agent-session-model";
import { Button } from "@/components/ui/button";
import { dispatchOpenFile } from "@/lib/open-file";
import { cn } from "@/lib/utils";

import { toolSummary } from "./agent-tool-summary";
import { AgentMarkdown } from "./AgentMarkdown";
import { DiffBlock, editPreview, useToolPaths } from "./AgentTranscript";

type Respond = (response: AgentResponse) => void;

const DESTINATIONS: { value: PermissionDestination; label: string }[] = [
  { value: "session", label: "this session" },
  { value: "localSettings", label: "this project, just me" },
  { value: "projectSettings", label: "this project, shared" },
  { value: "userSettings", label: "all my projects" },
];

function asDestination(value: string): PermissionDestination {
  return DESTINATIONS.find((d) => d.value === value)?.value ?? "session";
}

/** A digit key 1–9 as a zero-based index, or null. Typing in the card's fields keeps digits. */
function digitIndex(e: React.KeyboardEvent): number | null {
  if (e.metaKey || e.ctrlKey || e.altKey) return null;
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return null;
  return /^[1-9]$/.test(e.key) ? Number(e.key) - 1 : null;
}

/** Marks a request card, so "Claude is waiting for you" can bring it into view. */
export const REQUEST_CARD_ATTR = "data-agent-request";

function CardShell({
  title,
  aside,
  onKeyDown,
  children,
}: {
  title: React.ReactNode;
  aside?: React.ReactNode;
  onKeyDown?: (e: React.KeyboardEvent) => void;
  children: React.ReactNode;
}) {
  return (
    <div
      {...{ [REQUEST_CARD_ATTR]: "" }}
      // Focusable so its shortcuts work once the user clicks into it; never focused on its own.
      tabIndex={-1}
      onKeyDown={onKeyDown}
      className="bg-popover ring-ring/35 focus-within:ring-ring/70 rounded-xl p-4 shadow-lg ring-1 outline-none"
    >
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-ring mb-1 flex items-center gap-1.5 text-[11px] font-medium tracking-wide uppercase">
            <span className="bg-ring size-1.5 rounded-full" />
            Needs you
          </div>
          <div className="text-foreground text-[15px] leading-snug font-semibold">{title}</div>
        </div>
        {aside}
      </div>
      {children}
    </div>
  );
}

/** A numbered choice with a radio or checkbox mark. */
function Choice({
  index,
  selected,
  multi,
  label,
  description,
  onSelect,
}: {
  index: number;
  selected: boolean;
  multi: boolean;
  label: React.ReactNode;
  description?: string;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role={multi ? "checkbox" : "radio"}
      aria-checked={selected}
      onClick={onSelect}
      className={cn(
        "hover:bg-foreground/[0.05] flex w-full items-start gap-3 rounded-lg px-2.5 py-2 text-left",
        selected && "bg-ring/10 hover:bg-ring/15",
      )}
    >
      <span
        className={cn(
          "border-muted-foreground/60 mt-0.5 flex size-4 shrink-0 items-center justify-center border",
          multi ? "rounded-[4px]" : "rounded-full",
          selected && "border-ring bg-ring text-white",
        )}
      >
        {selected &&
          (multi ? (
            <CheckIcon className="size-3" strokeWidth={3} />
          ) : (
            <span className="size-1.5 rounded-full bg-white" />
          ))}
      </span>
      <span className="min-w-0 flex-1">
        <span className="text-foreground block text-[13px] font-medium">{label}</span>
        {description && (
          <span className="text-muted-foreground block text-[12px] leading-snug">
            {description}
          </span>
        )}
      </span>
      <kbd className="text-muted-foreground border-border mt-0.5 rounded border px-1 font-mono text-[10px]">
        {index + 1}
      </kbd>
    </button>
  );
}

function Shortcut({ n }: { n: number }) {
  return <kbd className="ml-1 font-mono text-[10px] opacity-60">{n}</kbd>;
}

const fieldClass =
  "border-border bg-background placeholder:text-muted-foreground focus-visible:border-ring w-full rounded-lg border px-2.5 py-1.5 text-[13px] outline-none";

const codeClass =
  "bg-foreground/[0.04] max-h-60 overflow-auto rounded-md px-3 py-2 font-mono text-[12px] whitespace-pre-wrap";

function PermissionCard({
  request,
  respond,
}: {
  request: Extract<AgentRequest, { kind: "permission" }>;
  respond: Respond;
}) {
  const [feedback, setFeedback] = useState("");
  const [destination, setDestination] = useState<PermissionDestination>(() =>
    asDestination(request.suggestions[0]?.destination ?? "session"),
  );
  const summary = toolSummary(request.toolName, request.input, useToolPaths());
  const canAlwaysAllow = !request.suppressAlwaysAllow && request.suggestions.length > 0;
  const diff = editPreview(request.input);
  const command = request.toolName === "Bash" ? request.input.command : undefined;

  const allowOnce = () => respond({ kind: "permission", allow: true });
  const alwaysAllow = () =>
    respond({
      kind: "permission",
      allow: true,
      alwaysAllow: request.suggestions.map((_, index) => ({ index, destination })),
    });
  const deny = () => respond({ kind: "permission", allow: false, message: feedback });
  const actions = [allowOnce, ...(canAlwaysAllow ? [alwaysAllow] : []), deny];

  return (
    <CardShell
      title={
        <>
          Allow {request.displayName}
          {summary && (
            <span className="text-muted-foreground ml-1.5 font-mono text-[13px] font-normal">
              {summary}
            </span>
          )}
          ?
        </>
      }
      onKeyDown={(e) => {
        const index = digitIndex(e);
        const action = index === null ? undefined : actions[index];
        // An ask that must not be one keystroke away takes no digit shortcuts.
        if (!action || request.defaultToNo) return;
        e.preventDefault();
        action();
      }}
    >
      {/* What runs, in full: a summary or the agent's own description could hide a second line. */}
      {diff ? (
        <DiffBlock lines={diff} />
      ) : (
        <pre className={codeClass}>
          {typeof command === "string" ? command : JSON.stringify(request.input, null, 2)}
        </pre>
      )}
      {(request.description || request.reason) && (
        <p className="text-muted-foreground mt-2 text-[12px]">
          {[request.description, request.reason].filter(Boolean).join(" · ")}
        </p>
      )}
      {canAlwaysAllow && (
        <p className="text-muted-foreground mt-2 flex flex-wrap items-center gap-1 text-[12px]">
          Always allow saves
          <code className="text-foreground/90 font-mono">
            {request.suggestions.map((s) => s.label).join(", ")}
          </code>
          for
          <select
            aria-label="Where an always-allow rule is saved"
            value={destination}
            onChange={(e) => setDestination(asDestination(e.target.value))}
            className="text-foreground/90 hover:bg-foreground/[0.06] rounded bg-transparent px-0.5 text-[12px] underline decoration-dotted underline-offset-2 outline-none"
          >
            {DESTINATIONS.map((d) => (
              <option key={d.value} value={d.value}>
                {d.label}
              </option>
            ))}
          </select>
        </p>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button size="sm" variant={request.defaultToNo ? "outline" : "default"} onClick={allowOnce}>
          Allow once
          <Shortcut n={1} />
        </Button>
        {canAlwaysAllow && (
          <Button size="sm" variant="outline" onClick={alwaysAllow}>
            Always allow
            <Shortcut n={2} />
          </Button>
        )}
        <Button size="sm" variant={request.defaultToNo ? "default" : "ghost"} onClick={deny}>
          Deny
          <Shortcut n={canAlwaysAllow ? 3 : 2} />
        </Button>
      </div>
      <input
        value={feedback}
        onChange={(e) => setFeedback(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.nativeEvent.isComposing) {
            e.preventDefault();
            deny();
          }
        }}
        placeholder="Or tell Claude what to do instead (Enter denies)"
        className={cn(fieldClass, "mt-2")}
      />
    </CardShell>
  );
}

function QuestionCard({
  request,
  respond,
}: {
  request: Extract<AgentRequest, { kind: "question" }>;
  respond: Respond;
}) {
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const [other, setOther] = useState<Record<string, string>>({});
  // Digit keys pick in the question the user last touched.
  const [active, setActive] = useState(0);
  const single = request.questions.length === 1 ? request.questions[0] : undefined;

  const toggle = (question: string, label: string, multi: boolean) => {
    setOther((prev) => ({ ...prev, [question]: "" }));
    setPicked((prev) => {
      const current = prev[question] ?? [];
      if (!multi) return { ...prev, [question]: [label] };
      return {
        ...prev,
        [question]: current.includes(label)
          ? current.filter((l) => l !== label)
          : [...current, label],
      };
    });
  };

  const answers = Object.fromEntries(
    request.questions.map((q) => {
      const typed = other[q.question]?.trim();
      return [q.question, typed || (picked[q.question] ?? []).join(", ")];
    }),
  );
  const complete = request.questions.every((q) => answers[q.question]);
  const submit = () => {
    if (complete) respond({ kind: "question", answers });
  };

  return (
    <CardShell
      title={single ? single.question : "Claude has a few questions"}
      onKeyDown={(e) => {
        const index = digitIndex(e);
        const q = request.questions[active];
        const option = index === null ? undefined : q?.options[index];
        if (q && option) {
          e.preventDefault();
          toggle(q.question, option.label, q.multiSelect);
          return;
        }
        if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
          e.preventDefault();
          submit();
        }
      }}
    >
      <div className="space-y-4">
        {request.questions.map((q, qi) => (
          <fieldset key={q.question} onFocus={() => setActive(qi)} onClick={() => setActive(qi)}>
            {!single && (
              <legend className="text-foreground mb-1.5 text-[13px] font-medium">
                <span className="text-muted-foreground mr-1.5">{qi + 1}.</span>
                {q.question}
              </legend>
            )}
            {q.multiSelect && (
              <p className="text-muted-foreground mb-1 px-2.5 text-[12px]">Pick any that apply</p>
            )}
            <div className="space-y-0.5" role={q.multiSelect ? "group" : "radiogroup"}>
              {q.options.map((o, oi) => (
                <Choice
                  key={o.label}
                  index={oi}
                  selected={(picked[q.question] ?? []).includes(o.label)}
                  multi={q.multiSelect}
                  label={o.label}
                  description={o.description}
                  onSelect={() => toggle(q.question, o.label, q.multiSelect)}
                />
              ))}
            </div>
            <input
              value={other[q.question] ?? ""}
              onChange={(e) => {
                const value = e.target.value;
                setOther((prev) => ({ ...prev, [q.question]: value }));
                if (value) setPicked((prev) => ({ ...prev, [q.question]: [] }));
              }}
              placeholder="Something else…"
              className={cn(fieldClass, "mt-1.5")}
            />
          </fieldset>
        ))}
      </div>
      <div className="mt-3 flex items-center gap-3">
        <Button size="sm" disabled={!complete} onClick={submit}>
          Answer
        </Button>
        <span className="text-muted-foreground text-[12px]">1–9 to pick · Enter to answer</span>
      </div>
    </CardShell>
  );
}

const APPROVE_MODES: { mode: AgentPermissionMode; label: string }[] = [
  { mode: "acceptEdits", label: "Approve and accept edits" },
  { mode: "default", label: "Approve, review each edit" },
];

function PlanCard({
  request,
  respond,
}: {
  request: Extract<AgentRequest, { kind: "plan" }>;
  respond: Respond;
}) {
  const [feedback, setFeedback] = useState("");
  const approve = (mode: AgentPermissionMode) => respond({ kind: "plan", approve: true, mode });
  const keepPlanning = () => respond({ kind: "plan", approve: false, feedback });
  const actions = [
    ...APPROVE_MODES.map(
      ({ mode }) =>
        () =>
          approve(mode),
    ),
    keepPlanning,
  ];
  const { planFilePath } = request;

  return (
    <CardShell
      title="Ready to build this plan?"
      aside={
        planFilePath && (
          <Button size="xs" variant="ghost" onClick={() => dispatchOpenFile(planFilePath)}>
            <FileTextIcon /> Open in editor
          </Button>
        )
      }
      onKeyDown={(e) => {
        const index = digitIndex(e);
        const action = index === null ? undefined : actions[index];
        if (!action) return;
        e.preventDefault();
        action();
      }}
    >
      <div className="bg-editor-surface border-border/70 max-h-[50vh] overflow-y-auto rounded-lg border px-6 py-5">
        <AgentMarkdown text={request.plan} />
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {APPROVE_MODES.map(({ mode, label }, i) => (
          <Button
            key={mode}
            size="sm"
            variant={i === 0 ? "default" : "outline"}
            onClick={() => approve(mode)}
          >
            {label}
            <Shortcut n={i + 1} />
          </Button>
        ))}
      </div>
      <div className="mt-2 flex items-center gap-2">
        <input
          value={feedback}
          onChange={(e) => setFeedback(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && feedback.trim() && !e.nativeEvent.isComposing) {
              e.preventDefault();
              keepPlanning();
            }
          }}
          placeholder="Or tell Claude what to change"
          className={fieldClass}
        />
        <Button size="sm" variant="ghost" className="shrink-0" onClick={keepPlanning}>
          Keep planning
          <Shortcut n={3} />
        </Button>
      </div>
    </CardShell>
  );
}

export function AgentRequestCard({
  request,
  respond,
}: {
  request: AgentRequest;
  respond: Respond;
}) {
  switch (request.kind) {
    case "permission":
      return <PermissionCard request={request} respond={respond} />;
    case "question":
      return <QuestionCard request={request} respond={respond} />;
    case "plan":
      return <PlanCard request={request} respond={respond} />;
    default: {
      const _unknown: never = request;
      return null;
    }
  }
}
