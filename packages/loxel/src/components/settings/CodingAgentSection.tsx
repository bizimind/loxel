import { useState } from "react";

import { Switch } from "@/components/ui/switch";
import {
  AGENT_FUNCTIONS,
  type AgentFunction,
  type ModelEntry,
  useSettingsStore,
} from "@/store/settings-store";

export function CodingAgentSection() {
  const models = useSettingsStore((s) => s.models);
  const settings = useSettingsStore((s) => s.codingAgent);
  const setBaseModelId = useSettingsStore((s) => s.setBaseModelId);
  const setFunctionOverride = useSettingsStore((s) => s.setFunctionOverride);
  const setDefaultMode = useSettingsStore((s) => s.setDefaultMode);
  const setDefaultProfile = useSettingsStore((s) => s.setDefaultProfile);

  const hasOverrides = Object.keys(settings.functionOverrides).length > 0;
  const [showOverrides, setShowOverrides] = useState(hasOverrides);

  const handleToggleOverrides = (checked: boolean) => {
    setShowOverrides(checked);
    if (!checked) {
      // Clear all overrides
      for (const { key } of AGENT_FUNCTIONS) {
        setFunctionOverride(key, null);
      }
    }
  };

  if (models.length === 0) {
    return (
      <div className="space-y-5">
        <div>
          <h3 className="text-foreground text-sm font-medium">Coding Agent</h3>
          <p className="text-muted-foreground mt-1 text-xs">
            Configure which models the coding agent uses.
          </p>
        </div>
        <div className="rounded-md bg-[var(--surface-2)] px-4 py-6 text-center">
          <p className="text-muted-foreground text-xs">No models configured.</p>
          <p className="text-muted-foreground mt-1 text-[10px]">
            Add models in the Models tab first.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-foreground text-sm font-medium">Coding Agent</h3>
        <p className="text-muted-foreground mt-1 text-xs">
          Configure which models the coding agent uses. Settings apply to newly created sessions.
        </p>
      </div>

      {/* Base Model */}
      <div className="space-y-1.5">
        <label className="text-muted-foreground text-xs">Base Model</label>
        <p className="text-muted-foreground text-[10px]">
          Used for all agent functions by default.
        </p>
        <ModelSelect
          value={settings.baseModelId}
          onChange={setBaseModelId}
          placeholder="Select a model..."
          models={models}
        />
      </div>

      {/* Session Defaults */}
      <div className="flex gap-4">
        <div className="flex-1 space-y-1.5">
          <label className="text-muted-foreground text-xs">Default Mode</label>
          <select
            value={settings.defaultMode ?? "execute"}
            onChange={(e) => setDefaultMode(e.target.value as "execute" | "plan" | undefined)}
            className="h-8 w-full rounded-md border border-[var(--border)] bg-[var(--surface-2)] px-2.5 text-xs text-[var(--foreground)] transition-colors"
          >
            <option value="execute">Execute</option>
            <option value="plan">Plan</option>
          </select>
        </div>
        <div className="flex-1 space-y-1.5">
          <label className="text-muted-foreground text-xs">Default Profile</label>
          <select
            value={settings.defaultProfile ?? "execute"}
            onChange={(e) =>
              setDefaultProfile(e.target.value as "execute" | "plan" | "minimal" | undefined)
            }
            className="h-8 w-full rounded-md border border-[var(--border)] bg-[var(--surface-2)] px-2.5 text-xs text-[var(--foreground)] transition-colors"
          >
            <option value="execute">Execute</option>
            <option value="plan">Plan</option>
            <option value="minimal">Minimal</option>
          </select>
        </div>
      </div>

      {/* Function Overrides */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <span className="text-foreground text-xs font-medium">Function Overrides</span>
            <p className="text-muted-foreground mt-0.5 text-[10px]">
              Use different models for specific functions.
            </p>
          </div>
          <Switch checked={showOverrides} onCheckedChange={handleToggleOverrides} />
        </div>

        {showOverrides && (
          <div className="space-y-2 rounded-md bg-[var(--surface-2)] p-3">
            {AGENT_FUNCTIONS.map(({ key, label }) => (
              <OverrideRow
                key={key}
                label={label}
                fn={key}
                value={settings.functionOverrides[key] ?? ""}
                models={models}
                onChange={setFunctionOverride}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function OverrideRow({
  label,
  fn,
  value,
  models,
  onChange,
}: {
  label: string;
  fn: AgentFunction;
  value: string;
  models: Pick<ModelEntry, "id" | "label">[];
  onChange: (fn: AgentFunction, modelId: string | null) => void;
}) {
  return (
    <div className="flex items-center gap-3">
      <span className="text-muted-foreground w-24 shrink-0 text-xs">{label}</span>
      <ModelSelect
        value={value}
        onChange={(id) => onChange(fn, id || null)}
        placeholder="Use base model"
        models={models}
        allowEmpty
      />
    </div>
  );
}

function ModelSelect({
  value,
  onChange,
  placeholder,
  models,
  allowEmpty,
}: {
  value: string;
  onChange: (id: string) => void;
  placeholder: string;
  models: Pick<ModelEntry, "id" | "label">[];
  allowEmpty?: boolean;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="h-8 w-full rounded-md border border-[var(--border)] bg-[var(--surface-2)] px-2.5 text-xs text-[var(--foreground)] transition-colors"
    >
      <option value="">{allowEmpty ? placeholder : `-- ${placeholder} --`}</option>
      {models.map((m) => (
        <option key={m.id} value={m.id}>
          {m.label}
        </option>
      ))}
    </select>
  );
}
