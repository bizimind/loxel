import type { Check, CheckStatus, InitActionId } from "@bizimind/wt/lib";
import { AlertTriangleIcon, CheckCircle2Icon, InfoIcon, XCircleIcon } from "lucide-react";
import { useId } from "react";

import type { RepoSetupPlan } from "@/api/project-model";

import { visibleSetupChecks } from "./repo-setup";

/**
 * What `wt doctor` finds in an existing repository, with the `wt init` fixes for it as checkboxes.
 * The checked fixes run when the project is added.
 */
export function RepoSetupChecks({
  plan,
  apply,
  onToggle,
}: {
  plan: RepoSetupPlan;
  apply: InitActionId[];
  onToggle: (id: InitActionId) => void;
}) {
  const checks = visibleSetupChecks(plan);

  return (
    <div>
      <span className="text-foreground mb-1.5 block text-xs font-medium">Repository setup</span>
      {checks.length === 0 ? (
        <div className="flex items-center gap-1.5">
          <CheckCircle2Icon className="text-link size-3.5 shrink-0" />
          <span className="text-link text-xs">Set up for worktrees</span>
        </div>
      ) : (
        <div className="space-y-2">
          <p className="text-muted-foreground text-[11px]">
            Checked fixes are applied when you add the project.
          </p>
          {checks.map((check) => (
            <SetupCheck
              key={check.id}
              check={check}
              plan={plan}
              apply={apply}
              onToggle={onToggle}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function SetupCheck({
  check,
  plan,
  apply,
  onToggle,
}: {
  check: Check;
  plan: RepoSetupPlan;
  apply: InitActionId[];
  onToggle: (id: InitActionId) => void;
}) {
  const actions = plan.actions.filter((action) => action.check === check.id);
  const idPrefix = useId();

  return (
    <div className="border-border rounded-md border px-3 py-2">
      <div className="flex items-start gap-1.5">
        <CheckStatusIcon status={check.status} />
        <div className="min-w-0">
          <span className="text-foreground text-xs font-medium">{check.title}</span>
          <p className="text-muted-foreground text-[11px] break-words">{check.summary}</p>
          {check.affects.length > 0 && (
            <ul className="text-muted-foreground list-disc pl-4 text-[11px]">
              {check.affects.map((effect) => (
                <li key={effect}>{effect}</li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {actions.map((action) => (
        <div key={action.id} className="mt-2 flex items-start gap-2 pl-5">
          <input
            id={`${idPrefix}-${action.id}`}
            type="checkbox"
            checked={apply.includes(action.id)}
            onChange={() => onToggle(action.id)}
            className="accent-primary mt-0.5 size-3 shrink-0 cursor-pointer"
          />
          <div className="min-w-0 space-y-1">
            <div className="flex flex-wrap items-center gap-1.5">
              <label
                htmlFor={`${idPrefix}-${action.id}`}
                className="text-foreground cursor-pointer text-xs"
              >
                {action.title}
              </label>
              {action.recommended && (
                <span className="bg-primary/10 text-link rounded px-1.5 py-0.5 text-[10px] font-medium">
                  recommended
                </span>
              )}
            </div>
            <p className="text-muted-foreground text-[11px]">{action.recommendation}</p>
            {action.tradeoffs.length > 0 && (
              <ul className="text-muted-foreground list-disc pl-4 text-[11px]">
                {action.tradeoffs.map((tradeoff) => (
                  <li key={tradeoff}>{tradeoff}</li>
                ))}
              </ul>
            )}
            <pre className="bg-muted text-foreground overflow-x-auto rounded-md p-1.5 text-[10px] leading-relaxed">
              {action.commands.join("\n")}
            </pre>
          </div>
        </div>
      ))}
    </div>
  );
}

function CheckStatusIcon({ status }: { status: CheckStatus }) {
  if (status === "fail")
    return <XCircleIcon className="text-destructive mt-0.5 size-3.5 shrink-0" />;
  if (status === "warn") {
    return <AlertTriangleIcon className="text-warning mt-0.5 size-3.5 shrink-0" />;
  }
  return <InfoIcon className="text-muted-foreground mt-0.5 size-3.5 shrink-0" />;
}
