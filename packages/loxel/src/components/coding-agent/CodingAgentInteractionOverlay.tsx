/**
 * Interaction overlay for coding agent — handles human input requests and tool approvals.
 * Adapted from ccm-web CodingAgentInteractionOverlay.
 */
import { HelpCircle, ShieldAlert } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import type { PendingApproval, PendingHumanInput } from "@/api/coding-agent-model";
import { Button } from "@/components/ui/button";

interface CodingAgentInteractionOverlayProps {
  pendingHumanInput: PendingHumanInput | null;
  pendingApproval: PendingApproval | null;
  onSubmitHumanInput: (args: {
    runId: string;
    pendingKey: string;
    answers: Record<string, string[]>;
    freeform: Record<string, string>;
  }) => void;
  onSubmitApproval: (args: {
    runId: string;
    pendingKey: string;
    toolName: string;
    decision: string;
  }) => void;
}

function formatApprovalLabel(option: string): string {
  return option.replaceAll("_", " ");
}

export function CodingAgentInteractionOverlay({
  pendingHumanInput,
  pendingApproval,
  onSubmitHumanInput,
  onSubmitApproval,
}: CodingAgentInteractionOverlayProps) {
  const [selected, setSelected] = useState<Record<string, string[]>>({});
  const [freeform, setFreeform] = useState<Record<string, string>>({});

  useEffect(() => {
    setSelected({});
    setFreeform({});
  }, [pendingHumanInput?.pendingKey, pendingApproval?.pendingKey]);

  const allQuestionsAnswered = useMemo(() => {
    if (!pendingHumanInput) return false;
    return pendingHumanInput.questions.every((question) => {
      const values = selected[question.id] ?? [];
      return values.length > 0 || (freeform[question.id]?.trim().length ?? 0) > 0;
    });
  }, [pendingHumanInput, selected, freeform]);

  if (pendingHumanInput) {
    return (
      <div>
        <div className="mb-2 flex items-center gap-2">
          <HelpCircle className="text-muted-foreground size-4 shrink-0" />
          <span className="text-sm font-medium">Input Required</span>
        </div>

        <div className="space-y-4">
          {pendingHumanInput.questions.map((question) => {
            const values = selected[question.id] ?? [];
            return (
              <div key={question.id} className="space-y-2">
                <p className="text-sm font-medium">{question.question}</p>
                <div className="space-y-2">
                  {question.options.map((option) => {
                    const checked = values.includes(option.label);
                    return (
                      <label
                        key={option.label}
                        className="border-border hover:bg-muted/40 flex cursor-pointer items-start gap-2 rounded-lg border p-2"
                      >
                        <input
                          type={question.multiSelect ? "checkbox" : "radio"}
                          name={question.id}
                          checked={checked}
                          onChange={(e) => {
                            setSelected((prev) => {
                              const current = prev[question.id] ?? [];
                              if (question.multiSelect) {
                                const next = e.target.checked
                                  ? Array.from(new Set([...current, option.label]))
                                  : current.filter((v) => v !== option.label);
                                return { ...prev, [question.id]: next };
                              }
                              return {
                                ...prev,
                                [question.id]: e.target.checked ? [option.label] : [],
                              };
                            });
                          }}
                        />
                        <span className="text-sm">
                          <span className="font-medium">{option.label}</span>
                          <span className="text-muted-foreground ml-1">{option.description}</span>
                        </span>
                      </label>
                    );
                  })}
                </div>
                <input
                  type="text"
                  placeholder="Optional freeform note"
                  value={freeform[question.id] ?? ""}
                  onChange={(e) =>
                    setFreeform((prev) => ({ ...prev, [question.id]: e.target.value }))
                  }
                  className="border-input bg-background w-full rounded-md border px-3 py-2 text-sm"
                />
              </div>
            );
          })}
        </div>

        <Button
          size="sm"
          variant="secondary"
          disabled={!allQuestionsAnswered}
          onClick={() => {
            onSubmitHumanInput({
              runId: pendingHumanInput.runId,
              pendingKey: pendingHumanInput.pendingKey,
              answers: selected,
              freeform,
            });
          }}
          className="mt-3 w-full"
        >
          Submit Response
        </Button>
      </div>
    );
  }

  if (pendingApproval) {
    const options =
      pendingApproval.options.length > 0 ? pendingApproval.options : ["allow", "deny"];

    return (
      <div className="bg-card border-border w-fit overflow-hidden rounded-lg border">
        <div className="flex items-center gap-2 p-3 pb-0">
          <ShieldAlert className="text-muted-foreground size-4 shrink-0" />
          <span className="text-sm font-medium">Approval Required</span>
        </div>

        {pendingApproval.input && (
          <pre
            className="mx-3 mt-2 overflow-x-auto rounded-md px-3 py-2 text-xs leading-relaxed whitespace-pre-wrap"
            style={{
              fontFamily: "'JetBrains Mono NL', monospace",
              backgroundColor: "var(--editor-surface)",
            }}
          >
            <span className="text-muted-foreground/50">$ </span>
            {getApprovalSnippet(pendingApproval.toolName, pendingApproval.input)}
          </pre>
        )}

        <div className="flex flex-wrap gap-2 p-3">
          {options.map((option) => (
            <Button
              key={option}
              size="sm"
              variant={option === "deny" ? "destructive" : "secondary"}
              onClick={() =>
                onSubmitApproval({
                  runId: pendingApproval.runId,
                  pendingKey: pendingApproval.pendingKey,
                  toolName: pendingApproval.toolName,
                  decision: option,
                })
              }
              className="hover:bg-primary/50 border-transparent bg-[var(--surface-0)] capitalize shadow-sm transition-colors"
            >
              {formatApprovalLabel(option)}
            </Button>
          ))}
        </div>
      </div>
    );
  }

  return null;
}

/** Extract the most relevant snippet from a tool's input for display. */
function getApprovalSnippet(toolName: string, input: Record<string, unknown>): string {
  switch (toolName) {
    case "Bash":
      return typeof input.command === "string" ? input.command : JSON.stringify(input, null, 2);
    case "Write":
    case "Read":
    case "Edit":
    case "MultiEdit":
      return typeof input.file_path === "string" ? input.file_path : JSON.stringify(input, null, 2);
    default:
      return JSON.stringify(input, null, 2);
  }
}
