/**
 * What the agent waits on the user for: a tool permission, a question (AskUserQuestion) or a plan
 * to approve (ExitPlanMode). Each answers in the turn that asked, as the terminal does.
 */
import { ClipboardListIcon, MessageCircleQuestionIcon, ShieldQuestionIcon } from "lucide-react";
import { useState } from "react";

import type {
  AgentPermissionMode,
  AgentRequest,
  AgentResponse,
  PermissionDestination,
} from "@/api/agent-session-model";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import { toolSummary } from "./agent-tool-summary";
import { AgentMarkdown } from "./AgentMarkdown";
import { useToolPaths } from "./AgentTranscript";

type Respond = (response: AgentResponse) => void;

function asDestination(value: string): PermissionDestination {
  return DESTINATIONS.find((d) => d.value === value)?.value ?? "session";
}

/** The tool's input as it will run: a Bash command verbatim, anything else as JSON. */
function fullInput(toolName: string, input: Record<string, unknown>): string {
  if (toolName === "Bash" && typeof input.command === "string") return input.command;
  return JSON.stringify(input, null, 2);
}

const DESTINATIONS: { value: PermissionDestination; label: string }[] = [
  { value: "session", label: "this session" },
  { value: "localSettings", label: "this project, just me" },
  { value: "projectSettings", label: "this project, shared" },
  { value: "userSettings", label: "all my projects" },
];

function CardShell({
  icon,
  title,
  children,
}: {
  icon: React.ReactNode;
  title: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="border-ring/40 bg-background rounded-lg border p-3.5 shadow-sm">
      <div className="text-foreground mb-2 flex items-center gap-2 text-[13px] font-medium">
        {icon}
        {title}
      </div>
      {children}
    </div>
  );
}

function FeedbackInput({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
}) {
  return (
    <textarea
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      rows={2}
      className="border-border bg-background placeholder:text-muted-foreground focus-visible:border-ring mt-2 w-full resize-y rounded-md border px-2 py-1.5 text-xs outline-none"
    />
  );
}

function PermissionCard({
  request,
  respond,
}: {
  request: Extract<AgentRequest, { kind: "permission" }>;
  respond: Respond;
}) {
  const [feedback, setFeedback] = useState("");
  const [destinations, setDestinations] = useState<PermissionDestination[]>(() =>
    request.suggestions.map((s) => asDestination(s.destination)),
  );
  const summary = toolSummary(request.toolName, request.input, useToolPaths());
  const canAlwaysAllow = !request.suppressAlwaysAllow && request.suggestions.length > 0;

  const alwaysAllow = () =>
    respond({
      kind: "permission",
      allow: true,
      alwaysAllow: request.suggestions.map((_, index) => ({
        index,
        destination: destinations[index] ?? "session",
      })),
    });

  return (
    <CardShell
      icon={<ShieldQuestionIcon className="text-ring size-4" />}
      title={
        <>
          Allow {request.displayName}
          {summary && (
            <span className="text-muted-foreground font-mono font-normal"> {summary}</span>
          )}
          ?
        </>
      }
    >
      {/* What runs, in full: a summary or the agent's own description could hide a second line. */}
      <pre className="bg-muted/60 mb-1.5 max-h-60 overflow-auto rounded px-2 py-1.5 font-mono text-[11px] whitespace-pre-wrap">
        {fullInput(request.toolName, request.input)}
      </pre>
      {request.description && (
        <p className="text-muted-foreground mb-1 text-[11px]">Claude: {request.description}</p>
      )}
      {request.reason && <p className="text-muted-foreground text-[11px]">{request.reason}</p>}
      {canAlwaysAllow &&
        request.suggestions.map((s, i) => (
          <label
            key={s.label}
            className="text-muted-foreground mt-2 flex flex-wrap items-center gap-1.5 text-[11px]"
          >
            Don't ask again for <code className="text-foreground font-mono">{s.label}</code> in
            <select
              value={destinations[i]}
              onChange={(e) => {
                const value = asDestination(e.target.value);
                setDestinations((prev) => prev.map((d, j) => (j === i ? value : d)));
              }}
              className="border-border bg-background rounded border px-1 py-0.5 text-[11px]"
            >
              {DESTINATIONS.map((d) => (
                <option key={d.value} value={d.value}>
                  {d.label}
                </option>
              ))}
            </select>
          </label>
        ))}
      <FeedbackInput
        value={feedback}
        onChange={setFeedback}
        placeholder="Optional: tell Claude what to do instead"
      />
      <div className="mt-2 flex flex-wrap gap-1.5">
        {/* Never focused on its own: a request arriving while the user types must not take the
            next Enter or Space as an approval. */}
        <Button
          size="xs"
          variant={request.defaultToNo ? "outline" : "default"}
          onClick={() => respond({ kind: "permission", allow: true })}
        >
          Allow once
        </Button>
        {canAlwaysAllow && (
          <Button size="xs" variant="outline" onClick={alwaysAllow}>
            Always allow
          </Button>
        )}
        <Button
          size="xs"
          variant="outline"
          onClick={() => respond({ kind: "permission", allow: false, message: feedback })}
        >
          Deny
        </Button>
      </div>
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

  const toggle = (question: string, label: string, multi: boolean) =>
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

  const answers = Object.fromEntries(
    request.questions.map((q) => {
      const typed = other[q.question]?.trim();
      return [q.question, typed || (picked[q.question] ?? []).join(", ")];
    }),
  );
  const complete = request.questions.every((q) => answers[q.question]);

  return (
    <CardShell
      icon={<MessageCircleQuestionIcon className="text-ring size-4" />}
      title={request.questions.length > 1 ? "Claude has questions" : "Claude asks"}
    >
      <div className="space-y-3">
        {request.questions.map((q) => (
          <fieldset key={q.question}>
            <legend className="text-foreground mb-1 text-[13px]">
              {q.header && (
                <span className="bg-muted text-muted-foreground mr-1.5 rounded px-1 py-0.5 text-[10px] tracking-wide uppercase">
                  {q.header}
                </span>
              )}
              {q.question}
            </legend>
            <div className="space-y-1">
              {q.options.map((o) => {
                const selected = (picked[q.question] ?? []).includes(o.label);
                return (
                  <button
                    key={o.label}
                    type="button"
                    onClick={() => toggle(q.question, o.label, q.multiSelect)}
                    className={cn(
                      "border-border hover:bg-muted/60 flex w-full flex-col rounded-md border px-2.5 py-1.5 text-left",
                      selected && "border-ring bg-ring/10",
                    )}
                  >
                    <span className="text-foreground text-xs font-medium">{o.label}</span>
                    {o.description && (
                      <span className="text-muted-foreground text-[11px]">{o.description}</span>
                    )}
                  </button>
                );
              })}
              <input
                value={other[q.question] ?? ""}
                onChange={(e) => setOther((prev) => ({ ...prev, [q.question]: e.target.value }))}
                placeholder="Other…"
                className="border-border bg-background placeholder:text-muted-foreground focus-visible:border-ring w-full rounded-md border px-2.5 py-1.5 text-xs outline-none"
              />
            </div>
          </fieldset>
        ))}
      </div>
      <div className="mt-2.5 flex gap-1.5">
        <Button
          size="xs"
          disabled={!complete}
          onClick={() => respond({ kind: "question", answers })}
        >
          Answer
        </Button>
      </div>
    </CardShell>
  );
}

const APPROVE_MODES: { mode: AgentPermissionMode; label: string }[] = [
  { mode: "acceptEdits", label: "Approve, auto-accept edits" },
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
  return (
    <CardShell icon={<ClipboardListIcon className="text-ring size-4" />} title="Ready to code?">
      <div className="bg-editor-surface border-border/60 max-h-[45vh] overflow-y-auto rounded-md border px-4 py-3">
        <AgentMarkdown text={request.plan} />
      </div>
      <FeedbackInput
        value={feedback}
        onChange={setFeedback}
        placeholder="To keep planning, tell Claude what to change"
      />
      <div className="mt-2 flex flex-wrap gap-1.5">
        {APPROVE_MODES.map(({ mode, label }, i) => (
          <Button
            key={mode}
            size="xs"
            variant={i === 0 ? "default" : "outline"}
            onClick={() => respond({ kind: "plan", approve: true, mode })}
          >
            {label}
          </Button>
        ))}
        <Button
          size="xs"
          variant="outline"
          onClick={() => respond({ kind: "plan", approve: false, feedback })}
        >
          Keep planning
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
