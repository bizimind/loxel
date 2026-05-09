import type { MigrationPlan } from "@bizimind/localdb-sdk";

import { Button } from "@/components/ui/button";

interface Props {
  plan: MigrationPlan;
  onApply: () => void;
  onCancel: () => void;
}

export function MigrationReview({ plan, onApply, onCancel }: Props) {
  return (
    <div className="border-border rounded-md border p-4">
      <h3 className="mb-2 text-sm font-medium">Schema Migration Required</h3>

      {plan.warnings.length > 0 && (
        <div className="mb-3 rounded bg-yellow-500/15 p-3 text-xs">
          <strong>Warnings:</strong>
          <ul className="mt-1 list-disc pl-4">
            {plan.warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="mb-3 text-xs">
        <strong>Steps:</strong>
        <ol className="mt-1 list-decimal pl-4">
          {plan.steps.map((s, i) => (
            <li key={i} className="mb-0.5">
              <code className="bg-muted rounded px-1 py-0.5 text-[0.8em]">{s.kind}</code>{" "}
              {s.description}
            </li>
          ))}
        </ol>
      </div>

      {plan.isDestructive && (
        <p className="text-destructive mb-3 text-xs font-semibold">
          ⚠ This migration is destructive and may cause data loss.
        </p>
      )}

      <div className="flex justify-end gap-2">
        <Button type="button" onClick={onCancel} variant="outline" size="sm">
          Cancel
        </Button>
        <Button
          type="button"
          onClick={onApply}
          variant={plan.isDestructive ? "destructive" : "default"}
          size="sm"
        >
          Apply Migration
        </Button>
      </div>
    </div>
  );
}
