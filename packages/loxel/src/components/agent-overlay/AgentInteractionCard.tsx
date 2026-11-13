import {
  MessageCircleQuestionIcon,
  ShieldQuestionIcon,
  SquareTerminalIcon,
  ClipboardListIcon,
} from "lucide-react";
import { useState } from "react";

import type {
  AgentAction,
  AgentActionResult,
  AgentDialogOption,
  AgentInteraction,
  AgentJson,
  AgentQuestion,
  AgentSessionSummary,
} from "@/api/agent-overlay-model";
import { permissionDecisionOf } from "@/api/agent-overlay-model";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { performAgentAction } from "@/store/agent-overlay";

import { AgentMarkdown, CodeBlock } from "./AgentMarkdown";

interface CardProps {
  session: AgentSessionSummary;
  onShowTerminal: () => void;
}

/** Runs an action, reporting a refusal; a fallback sends the user to the terminal. */
function useAction(terminalId: string) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<AgentActionResult | null>(null);
  const run = async (action: AgentAction) => {
    setBusy(true);
    setError(null);
    try {
      const result = await performAgentAction(terminalId, action);
      if (!result.ok) setError(result);
    } catch (err) {
      setError({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        fallback: false,
      });
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, run };
}

function Shell({
  icon: Icon,
  title,
  children,
  error,
  onShowTerminal,
}: {
  icon: typeof ShieldQuestionIcon;
  title: string;
  children: React.ReactNode;
  error: AgentActionResult | null;
  onShowTerminal: () => void;
}) {
  return (
    <div className="border-primary/40 bg-surface-1 rounded-lg border shadow-sm">
      <div className="border-border/60 flex items-center gap-2 border-b px-4 py-2.5">
        <Icon className="size-4 text-amber-400" />
        <span className="text-foreground text-[13px] font-medium">{title}</span>
        <button
          type="button"
          className="text-muted-foreground hover:text-foreground ml-auto flex items-center gap-1 text-xs"
          onClick={onShowTerminal}
          title="Answer in the terminal instead"
        >
          <SquareTerminalIcon className="size-3.5" />
          Terminal
        </button>
      </div>
      <div className="space-y-3 px-4 py-3">{children}</div>
      {error && !error.ok && (
        <div className="border-border/60 flex items-center gap-2 border-t px-4 py-2 text-xs text-red-400">
          <span className="min-w-0 flex-1">{error.error}</span>
          {error.fallback && (
            <Button size="xs" variant="outline" onClick={onShowTerminal}>
              Continue in terminal
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

function toolSummary(
  toolName: string,
  input: AgentJson,
): { code: string; language: string | null } {
  if (typeof input === "object" && input !== null && !Array.isArray(input)) {
    const fields = input as Record<string, AgentJson>;
    if (toolName === "Bash" && typeof fields.command === "string") {
      return { code: fields.command, language: "shellscript" };
    }
    if (typeof fields.file_path === "string" && Object.keys(fields).length <= 2) {
      return { code: fields.file_path, language: null };
    }
  }
  return { code: JSON.stringify(input, null, 2), language: "json" };
}

/** What "always allow" adds, from the agent's suggestions: `Bash(python3 *) → localSettings`. */
function describeSuggestions(suggestions: AgentJson[]): string[] {
  return suggestions.flatMap((suggestion) => {
    if (typeof suggestion !== "object" || suggestion === null || Array.isArray(suggestion))
      return [];
    const entry = suggestion as Record<string, AgentJson>;
    const destination = typeof entry.destination === "string" ? entry.destination : "session";
    if (entry.type === "setMode") return [`Switch to ${String(entry.mode)} (${destination})`];
    if (!Array.isArray(entry.rules)) return [];
    return entry.rules.map((rule) => {
      const fields = (rule ?? {}) as Record<string, AgentJson>;
      const content = typeof fields.ruleContent === "string" ? `(${fields.ruleContent})` : "";
      return `${String(fields.toolName ?? "tool")}${content} → ${destination}`;
    });
  });
}

type PermissionChoice = {
  option: AgentDialogOption | null;
  label: string;
  decision: "allow" | "always" | "deny" | null;
};

/** The dialog's choices as the terminal words them, or the usual three until it is on screen. */
function permissionChoices(options: AgentDialogOption[] | null): PermissionChoice[] {
  if (!options) {
    return [
      { option: null, label: "Yes", decision: "allow" },
      { option: null, label: "Yes, and don't ask again", decision: "always" },
      { option: null, label: "No", decision: "deny" },
    ];
  }
  return options.map((option) => ({
    option,
    label: option.label,
    decision: permissionDecisionOf(option.label),
  }));
}

function PermissionCard({
  session,
  interaction,
  onShowTerminal,
}: CardProps & { interaction: Extract<AgentInteraction, { kind: "permission" }> }) {
  const { busy, error, run } = useAction(session.terminalId);
  const [feedback, setFeedback] = useState("");
  const summary = toolSummary(interaction.toolName, interaction.toolInput);
  // Once the dialog is on screen its own wording says what "don't ask again" adds, which can be
  // broader than the hook's suggestion (`python3 *` for one python3 command).
  const rules = session.dialogOptions ? [] : describeSuggestions(interaction.suggestions);
  return (
    <Shell
      icon={ShieldQuestionIcon}
      title={`Claude wants to use ${interaction.toolName}`}
      error={error}
      onShowTerminal={onShowTerminal}
    >
      <CodeBlock code={summary.code} language={summary.language} />
      {rules.length > 0 && (
        <div className="text-muted-foreground text-xs">
          Always allow adds: <span className="text-foreground font-mono">{rules.join(", ")}</span>
        </div>
      )}
      <textarea
        className="border-border bg-editor-surface placeholder:text-muted-foreground focus:border-primary w-full resize-none rounded-md border px-3 py-2 text-[13px] outline-none"
        rows={1}
        placeholder="Feedback for Claude if you say no (optional)"
        value={feedback}
        onChange={(event) => setFeedback(event.target.value)}
      />
      <div className="flex flex-wrap gap-2">
        {permissionChoices(session.dialogOptions).map((choice) => (
          <Button
            key={choice.label}
            size="sm"
            variant={
              choice.decision === "allow"
                ? "default"
                : choice.decision === "deny"
                  ? "destructive"
                  : "outline"
            }
            disabled={busy}
            onClick={() => {
              if (choice.decision === null) {
                onShowTerminal();
                return;
              }
              void run({
                type: "permission",
                interactionId: interaction.id,
                decision: choice.decision,
                feedback: choice.decision === "deny" ? feedback : undefined,
              });
            }}
          >
            {choice.label}
          </Button>
        ))}
      </div>
    </Shell>
  );
}

function QuestionCard({
  session,
  interaction,
  onShowTerminal,
}: CardProps & { interaction: Extract<AgentInteraction, { kind: "question" }> }) {
  const { busy, error, run } = useAction(session.terminalId);
  const [chosen, setChosen] = useState<string[][]>(() => interaction.questions.map(() => []));
  const [other, setOther] = useState<string[]>(() => interaction.questions.map(() => ""));
  const toggle = (index: number, question: AgentQuestion, label: string) => {
    setChosen((current) =>
      current.map((labels, at) => {
        if (at !== index) return labels;
        if (!question.multiSelect) return [label];
        return labels.includes(label) ? labels.filter((l) => l !== label) : [...labels, label];
      }),
    );
    setOther((current) =>
      current.map((text, at) => (at === index && !question.multiSelect ? "" : text)),
    );
  };
  const complete = interaction.questions.every(
    (_question, index) =>
      (chosen[index]?.length ?? 0) > 0 || (other[index] ?? "").trim().length > 0,
  );
  return (
    <Shell
      icon={MessageCircleQuestionIcon}
      title={
        interaction.questions.length === 1
          ? "Claude has a question"
          : `Claude has ${interaction.questions.length} questions`
      }
      error={error}
      onShowTerminal={onShowTerminal}
    >
      {interaction.questions.map((question, index) => (
        <div key={question.question} className="space-y-2">
          <div className="flex items-baseline gap-2">
            {question.header && (
              <span className="bg-muted text-muted-foreground rounded px-1.5 py-0.5 text-[11px] font-medium">
                {question.header}
              </span>
            )}
            <span className="text-foreground text-[14px]">{question.question}</span>
            {question.multiSelect && (
              <span className="text-muted-foreground text-xs">Choose any</span>
            )}
          </div>
          <div className="grid gap-1.5 sm:grid-cols-2">
            {question.options.map((option) => {
              const selected = chosen[index]?.includes(option.label) ?? false;
              return (
                <button
                  key={option.label}
                  type="button"
                  className={cn(
                    "border-border hover:border-primary/60 rounded-md border px-3 py-2 text-left transition-colors",
                    selected && "border-primary bg-primary/15",
                  )}
                  onClick={() => toggle(index, question, option.label)}
                >
                  <div className="text-foreground text-[13px] font-medium">{option.label}</div>
                  {option.description && (
                    <div className="text-muted-foreground text-xs">{option.description}</div>
                  )}
                </button>
              );
            })}
          </div>
          {!question.multiSelect && (
            <input
              className="border-border bg-editor-surface placeholder:text-muted-foreground focus:border-primary w-full rounded-md border px-3 py-1.5 text-[13px] outline-none"
              placeholder="Or type your own answer"
              value={other[index] ?? ""}
              onChange={(event) => {
                const text = event.target.value;
                setOther((current) => current.map((value, at) => (at === index ? text : value)));
                if (text)
                  setChosen((current) => current.map((labels, at) => (at === index ? [] : labels)));
              }}
            />
          )}
        </div>
      ))}
      <div className="flex gap-2">
        <Button
          size="sm"
          disabled={busy || !complete}
          onClick={() =>
            void run({
              type: "question",
              interactionId: interaction.id,
              answers: interaction.questions.map((_question, index) => ({
                labels: chosen[index] ?? [],
                other: other[index]?.trim() || undefined,
              })),
            })
          }
        >
          Submit answers
        </Button>
      </div>
    </Shell>
  );
}

function PlanCard({
  session,
  interaction,
  onShowTerminal,
}: CardProps & { interaction: Extract<AgentInteraction, { kind: "plan" }> }) {
  const { busy, error, run } = useAction(session.terminalId);
  const [feedback, setFeedback] = useState("");
  return (
    <Shell
      icon={ClipboardListIcon}
      title="Claude's plan is ready"
      error={error}
      onShowTerminal={onShowTerminal}
    >
      <div className="border-border max-h-[40vh] overflow-y-auto rounded-md border px-4 py-3">
        <AgentMarkdown text={interaction.plan || "(empty plan)"} />
      </div>
      <textarea
        className="border-border bg-editor-surface placeholder:text-muted-foreground focus:border-primary w-full resize-none rounded-md border px-3 py-2 text-[13px] outline-none"
        rows={2}
        placeholder="What should Claude change? (keeps planning)"
        value={feedback}
        onChange={(event) => setFeedback(event.target.value)}
      />
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          disabled={busy}
          onClick={() =>
            void run({ type: "plan", interactionId: interaction.id, decision: "approve-auto" })
          }
        >
          Approve, auto mode
        </Button>
        <Button
          size="sm"
          variant="secondary"
          disabled={busy}
          onClick={() =>
            void run({ type: "plan", interactionId: interaction.id, decision: "approve-manual" })
          }
        >
          Approve, review edits
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() =>
            void run({ type: "plan", interactionId: interaction.id, decision: "revise", feedback })
          }
        >
          {feedback.trim() ? "Send feedback" : "Keep planning"}
        </Button>
      </div>
    </Shell>
  );
}

/** What Claude waits on, answerable here; anything the overlay does not model points to the terminal. */
export function AgentInteractionCard({ session, onShowTerminal }: CardProps) {
  const { interaction } = session;
  if (!interaction) return null;
  switch (interaction.kind) {
    case "permission":
      return (
        <PermissionCard
          key={interaction.id}
          session={session}
          interaction={interaction}
          onShowTerminal={onShowTerminal}
        />
      );
    case "question":
      return (
        <QuestionCard
          key={interaction.id}
          session={session}
          interaction={interaction}
          onShowTerminal={onShowTerminal}
        />
      );
    case "plan":
      return (
        <PlanCard
          key={interaction.id}
          session={session}
          interaction={interaction}
          onShowTerminal={onShowTerminal}
        />
      );
    case "unknown":
      return (
        <Shell
          icon={ShieldQuestionIcon}
          title="Claude is waiting for you"
          error={null}
          onShowTerminal={onShowTerminal}
        >
          <div className="text-muted-foreground text-[13px]">{interaction.message}</div>
          <Button size="sm" onClick={onShowTerminal}>
            Answer in terminal
          </Button>
        </Shell>
      );
    default: {
      const unknown: never = interaction;
      return unknown;
    }
  }
}
