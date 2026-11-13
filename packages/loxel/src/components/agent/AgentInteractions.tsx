/**
 * Cards for what the agent needs from the user: answering its questions (AskUserQuestion),
 * allowing a tool call (once, always with the rule shown, or not), and approving a plan
 * (ExitPlanMode) with the mode to continue in, or sending it back with feedback.
 */
import {
  CheckIcon,
  ClipboardListIcon,
  ExternalLinkIcon,
  MessageCircleQuestionIcon,
  ShieldQuestionIcon,
} from "lucide-react";
import { useState, type ReactNode } from "react";

import {
  isPermissionDestination,
  PERMISSION_DESTINATIONS,
  PERMISSION_DESTINATION_LABELS,
  type AgentInteraction,
  type AgentQuestion,
  type InteractionResponse,
  type PermissionDestination,
} from "@/api/agent-session-model";
import { Button } from "@/components/ui/button";
import { dispatchLoxelEvent } from "@/lib/loxel-events";
import { cn } from "@/lib/utils";

import { AgentMarkdown } from "./AgentMarkdown";
import { inputField, toolSummary } from "./AgentTranscript";

type Respond = (response: InteractionResponse) => void;

function Card({
  icon,
  title,
  children,
}: {
  icon: ReactNode;
  title: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="border-border bg-background flex flex-col gap-3 rounded-lg border p-3.5 shadow-sm">
      <div className="text-foreground flex items-center gap-2 text-sm font-medium">
        {icon}
        {title}
      </div>
      {children}
    </div>
  );
}

const OTHER = "\u0000other";

function QuestionBlock({
  question,
  selected,
  other,
  onSelect,
  onOther,
}: {
  question: AgentQuestion;
  selected: string[];
  other: string;
  onSelect: (labels: string[]) => void;
  onOther: (text: string) => void;
}) {
  const [hovered, setHovered] = useState<string | null>(null);
  const toggle = (label: string) => {
    if (!question.multiSelect) return onSelect([label]);
    onSelect(selected.includes(label) ? selected.filter((l) => l !== label) : [...selected, label]);
  };
  const previewLabel = hovered ?? selected.find((l) => l !== OTHER) ?? null;
  const preview = question.options.find((o) => o.label === previewLabel)?.preview;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline gap-2">
        {question.header && (
          <span className="bg-muted text-muted-foreground rounded px-1.5 py-0.5 text-[11px] font-medium">
            {question.header}
          </span>
        )}
        <span className="text-foreground text-sm">{question.question}</span>
        {question.multiSelect && (
          <span className="text-muted-foreground text-[11px]">Choose any</span>
        )}
      </div>
      <div className="flex gap-3">
        <div
          className="flex min-w-0 flex-1 flex-col gap-1"
          role={question.multiSelect ? "group" : "radiogroup"}
        >
          {question.options.map((option, index) => {
            const isSelected = selected.includes(option.label);
            return (
              <button
                key={option.label}
                type="button"
                role={question.multiSelect ? "checkbox" : "radio"}
                aria-checked={isSelected}
                onClick={() => toggle(option.label)}
                onMouseEnter={() => setHovered(option.label)}
                onMouseLeave={() => setHovered(null)}
                className={cn(
                  "border-border hover:bg-muted/60 flex items-start gap-2 rounded-md border px-2.5 py-1.5 text-left",
                  isSelected && "border-ring bg-muted",
                )}
              >
                <span className="text-muted-foreground w-4 shrink-0 text-xs">{index + 1}.</span>
                <span className="flex min-w-0 flex-col">
                  <span className="text-foreground text-xs font-medium">{option.label}</span>
                  {option.description && (
                    <span className="text-muted-foreground text-xs">{option.description}</span>
                  )}
                </span>
                {isSelected && <CheckIcon className="ml-auto size-3.5 shrink-0" />}
              </button>
            );
          })}
          <input
            className="border-border focus:border-ring rounded-md border bg-transparent px-2.5 py-1.5 text-xs outline-none"
            placeholder="Other: type your own answer"
            value={other}
            onChange={(event) => {
              onOther(event.target.value);
              const withoutOther = selected.filter((l) => l !== OTHER);
              const hasText = event.target.value.trim() !== "";
              if (question.multiSelect) onSelect(hasText ? [...withoutOther, OTHER] : withoutOther);
              else onSelect(hasText ? [OTHER] : []);
            }}
          />
        </div>
        {preview && (
          <div className="border-border max-h-64 w-1/2 overflow-auto rounded-md border p-2">
            <AgentMarkdown text={preview} className="text-xs" />
          </div>
        )}
      </div>
    </div>
  );
}

function QuestionCard({
  interaction,
  respond,
}: {
  interaction: Extract<AgentInteraction, { kind: "question" }>;
  respond: Respond;
}) {
  const [selected, setSelected] = useState<Record<string, string[]>>({});
  const [other, setOther] = useState<Record<string, string>>({});
  const answerFor = (question: AgentQuestion): string | null => {
    const labels = (selected[question.question] ?? []).map((label) =>
      label === OTHER ? (other[question.question] ?? "").trim() : label,
    );
    const answer = labels.filter(Boolean).join(", ");
    return answer || null;
  };
  const complete = interaction.questions.every((q) => answerFor(q) !== null);
  const submit = () => {
    const answers: Record<string, string> = {};
    for (const question of interaction.questions) {
      const answer = answerFor(question);
      if (answer) answers[question.question] = answer;
    }
    respond({ kind: "question", answers });
  };
  return (
    <Card
      icon={<MessageCircleQuestionIcon className="size-4 text-sky-500" />}
      title={
        interaction.questions.length > 1 ? "Claude has some questions" : "Claude has a question"
      }
    >
      {interaction.questions.map((question) => (
        <QuestionBlock
          key={question.question}
          question={question}
          selected={selected[question.question] ?? []}
          other={other[question.question] ?? ""}
          onSelect={(labels) => setSelected((s) => ({ ...s, [question.question]: labels }))}
          onOther={(text) => setOther((o) => ({ ...o, [question.question]: text }))}
        />
      ))}
      <div className="flex justify-end gap-2">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => respond({ kind: "question", dismissed: true })}
        >
          Skip
        </Button>
        <Button size="sm" disabled={!complete} onClick={submit}>
          Answer
        </Button>
      </div>
    </Card>
  );
}

function PermissionCard({
  interaction,
  respond,
}: {
  interaction: Extract<AgentInteraction, { kind: "permission" }>;
  respond: Respond;
}) {
  const [feedback, setFeedback] = useState("");
  const [destinations, setDestinations] = useState<Record<string, PermissionDestination>>({});
  const summary = toolSummary(interaction.toolName, interaction.input);
  const command =
    interaction.toolName === "Bash" ? (inputField(interaction.input, "command") ?? null) : null;
  return (
    <Card
      icon={<ShieldQuestionIcon className="size-4 text-amber-500" />}
      title={interaction.title ?? `Allow ${interaction.toolName}${summary ? `: ${summary}` : ""}?`}
    >
      {interaction.description && (
        <p className="text-muted-foreground text-xs">{interaction.description}</p>
      )}
      <pre className="agent-tool-pre max-h-48">
        {command ?? JSON.stringify(interaction.input, null, 2)}
      </pre>
      {interaction.decisionReason && (
        <p className="text-muted-foreground text-[11px]">
          Why it asks: {interaction.decisionReason}
        </p>
      )}
      <div className="flex flex-col gap-1.5">
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={() => respond({ kind: "permission", decision: "allow" })}>
            Allow once
          </Button>
        </div>
        {interaction.suggestions.map((suggestion) => {
          const destination = destinations[suggestion.id] ?? suggestion.destination;
          return (
            <div key={suggestion.id} className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  respond({
                    kind: "permission",
                    decision: "allow",
                    always: [{ id: suggestion.id, destination }],
                  })
                }
              >
                Always allow
              </Button>
              <code className="bg-muted rounded px-1.5 py-0.5 font-mono text-[11px]">
                {suggestion.label}
              </code>
              {suggestion.movable ? (
                <select
                  className="border-border bg-background rounded border px-1 py-0.5 text-[11px]"
                  value={destination}
                  aria-label="Where to save the rule"
                  onChange={(event) => {
                    const next = event.target.value;
                    if (isPermissionDestination(next)) {
                      setDestinations((d) => ({ ...d, [suggestion.id]: next }));
                    }
                  }}
                >
                  {PERMISSION_DESTINATIONS.map((d) => (
                    <option key={d} value={d}>
                      in {PERMISSION_DESTINATION_LABELS[d]}
                    </option>
                  ))}
                </select>
              ) : (
                <span className="text-muted-foreground text-[11px]">
                  in {PERMISSION_DESTINATION_LABELS[destination]}
                </span>
              )}
            </div>
          );
        })}
      </div>
      <div className="flex items-center gap-2">
        <input
          className="border-border focus:border-ring min-w-0 flex-1 rounded-md border bg-transparent px-2.5 py-1.5 text-xs outline-none"
          placeholder="Deny, and tell Claude what to do instead (optional)"
          value={feedback}
          onChange={(event) => setFeedback(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter")
              respond({ kind: "permission", decision: "deny", message: feedback });
          }}
        />
        <Button
          size="sm"
          variant="destructive"
          onClick={() => respond({ kind: "permission", decision: "deny", message: feedback })}
        >
          Deny
        </Button>
        <Button
          size="sm"
          variant="ghost"
          title="Deny and stop the current turn"
          onClick={() =>
            respond({ kind: "permission", decision: "deny", message: feedback, stop: true })
          }
        >
          Deny & stop
        </Button>
      </div>
    </Card>
  );
}

function PlanCard({
  interaction,
  respond,
}: {
  interaction: Extract<AgentInteraction, { kind: "plan" }>;
  respond: Respond;
}) {
  const [feedback, setFeedback] = useState("");
  const { planFilePath } = interaction;
  return (
    <Card
      icon={<ClipboardListIcon className="size-4 text-violet-500" />}
      title={
        <>
          Ready to code?
          {planFilePath && (
            <button
              type="button"
              className="text-muted-foreground hover:text-foreground ml-auto flex items-center gap-1 text-[11px] font-normal"
              onClick={() =>
                dispatchLoxelEvent("loxel-open-markdown-editor", { filePath: planFilePath })
              }
            >
              <ExternalLinkIcon className="size-3" />
              Open plan
            </button>
          )}
        </>
      }
    >
      <div className="border-border max-h-[45vh] overflow-auto rounded-md border px-4 py-3">
        <AgentMarkdown text={interaction.plan} />
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          onClick={() => respond({ kind: "plan", decision: "approve", mode: "acceptEdits" })}
        >
          Approve, accept edits
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => respond({ kind: "plan", decision: "approve", mode: "default" })}
        >
          Approve, ask before edits
        </Button>
      </div>
      <div className="flex items-center gap-2">
        <input
          className="border-border focus:border-ring min-w-0 flex-1 rounded-md border bg-transparent px-2.5 py-1.5 text-xs outline-none"
          placeholder="Keep planning: what should change?"
          value={feedback}
          onChange={(event) => setFeedback(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter")
              respond({ kind: "plan", decision: "keep_planning", feedback });
          }}
        />
        <Button
          size="sm"
          variant="ghost"
          onClick={() => respond({ kind: "plan", decision: "keep_planning", feedback })}
        >
          Keep planning
        </Button>
      </div>
    </Card>
  );
}

export function AgentInteractionCard({
  interaction,
  respond,
}: {
  interaction: AgentInteraction;
  respond: Respond;
}) {
  switch (interaction.kind) {
    case "question":
      return <QuestionCard interaction={interaction} respond={respond} />;
    case "permission":
      return <PermissionCard interaction={interaction} respond={respond} />;
    case "plan":
      return <PlanCard interaction={interaction} respond={respond} />;
    default: {
      const unknown: never = interaction;
      return unknown;
    }
  }
}
