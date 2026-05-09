import { useCallback, useEffect, useState } from "react";

import type { NotificationSequences } from "@/store/settings-store";

import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { DEFAULT_TERMINAL_SCROLLBACK, useSettingsStore } from "@/store/settings-store";

export function TerminalSection() {
  const scrollbackLines = useSettingsStore((s) => s.terminal.scrollbackLines);
  const notificationSequences = useSettingsStore((s) => s.terminal.notificationSequences);
  const updateTerminal = useSettingsStore((s) => s.updateTerminal);

  // Local string state allows free typing; commit to store on blur.
  const [localValue, setLocalValue] = useState(String(scrollbackLines));

  // Sync local state when the store value changes externally (e.g. cancel/revert).
  useEffect(() => setLocalValue(String(scrollbackLines)), [scrollbackLines]);

  const handleChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setLocalValue(e.target.value);
  }, []);

  const handleBlur = useCallback(() => {
    const value = Number.parseInt(localValue, 10);
    if (Number.isFinite(value) && value >= 1000 && value <= 100_000) {
      updateTerminal({ scrollbackLines: value });
    } else {
      setLocalValue(String(scrollbackLines));
    }
  }, [localValue, scrollbackLines, updateTerminal]);

  const toggleSequence = useCallback(
    (key: keyof NotificationSequences) => {
      updateTerminal({
        notificationSequences: { ...notificationSequences, [key]: !notificationSequences[key] },
      });
    },
    [notificationSequences, updateTerminal],
  );

  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-foreground text-sm font-medium">Terminal</h3>
        <p className="text-muted-foreground mt-1 text-xs">Configure terminal behavior.</p>
      </div>

      <div className="space-y-1.5">
        <label className="text-muted-foreground text-xs">Scrollback Lines</label>
        <p className="text-muted-foreground text-[10px]">
          Maximum number of lines kept in terminal history. Default:{" "}
          {DEFAULT_TERMINAL_SCROLLBACK.toLocaleString()}.
        </p>
        <Input
          type="number"
          value={localValue}
          onChange={handleChange}
          onBlur={handleBlur}
          min={1000}
          max={100000}
          step={1000}
          className="h-8 w-32 text-xs"
        />
      </div>

      <div className="space-y-1.5">
        <label className="text-muted-foreground text-xs">Notification Sequences</label>
        <p className="text-muted-foreground text-[10px]">
          Detect notification escape sequences from terminal processes. Shows a badge on terminal
          tabs and worktree icons when a background terminal sends a notification.
        </p>
        <div className="space-y-2 pt-1">
          <NotificationToggle
            checked={notificationSequences.osc9}
            onChange={() => toggleSequence("osc9")}
            label="OSC 9"
            description="iTerm2 style"
          />
          <NotificationToggle
            checked={notificationSequences.osc777}
            onChange={() => toggleSequence("osc777")}
            label="OSC 777"
            description="rxvt-unicode style"
          />
          <NotificationToggle
            checked={notificationSequences.osc99}
            onChange={() => toggleSequence("osc99")}
            label="OSC 99"
            description="Kitty style"
          />
        </div>
      </div>
    </div>
  );
}

function NotificationToggle({
  checked,
  onChange,
  label,
  description,
}: {
  checked: boolean;
  onChange: () => void;
  label: string;
  description: string;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-foreground text-xs">{label}</span>
      <span className="text-muted-foreground text-[10px]">({description})</span>
      <Switch checked={checked} onCheckedChange={onChange} className="ml-auto" />
    </div>
  );
}
