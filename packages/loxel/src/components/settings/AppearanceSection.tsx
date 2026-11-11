import type { LucideIcon } from "lucide-react";
import { MonitorIcon, MoonIcon, SunIcon } from "lucide-react";

import { THEME_PREFERENCES, type ThemePreference } from "@/lib/theme-preference";
import { cn } from "@/lib/utils";
import { useSettingsStore } from "@/store/settings-store";

import { FontSettings } from "./FontSettings";
import { TerminalColorSchemes } from "./TerminalColorSchemes";

const THEME_LABELS: Record<ThemePreference, { label: string; icon: LucideIcon }> = {
  dark: { label: "Dark", icon: MoonIcon },
  light: { label: "Light", icon: SunIcon },
  system: { label: "System", icon: MonitorIcon },
};

export function AppearanceSection() {
  const theme = useSettingsStore((s) => s.theme);
  const setTheme = useSettingsStore((s) => s.setTheme);

  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-foreground text-sm font-medium">Appearance</h3>
        <p className="text-muted-foreground mt-1 text-xs">
          Choose how Loxel looks. Fonts are the ones installed on this computer: settings keep only
          the font&apos;s name, and where it isn&apos;t installed, Loxel shows its bundled font
          instead.
        </p>
      </div>

      <div className="space-y-1.5">
        <label id="settings-theme-label" className="text-muted-foreground text-xs">
          Theme
        </label>
        <p className="text-muted-foreground text-[10px] not-dark:text-[12px]">
          System follows your operating system&apos;s light or dark appearance.
        </p>
        <div
          role="radiogroup"
          aria-labelledby="settings-theme-label"
          // Light draws a grey track with the chosen segment raised in white, like a native control
          className="border-input not-dark:bg-muted inline-flex rounded-md border p-0.5 not-dark:border-transparent"
        >
          {THEME_PREFERENCES.map((value) => {
            const { label, icon: Icon } = THEME_LABELS[value];
            return (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={theme === value}
                onClick={() => setTheme(value)}
                className={cn(
                  "flex items-center gap-1.5 rounded px-3 py-1 text-xs transition-colors",
                  theme === value
                    ? "bg-accent text-accent-foreground not-dark:bg-background not-dark:text-link not-dark:font-medium not-dark:shadow-[0_0_0_1px_rgb(0_0_0/0.14),0_1px_3px_rgb(0_0_0/0.16)]"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                <Icon className="size-3.5" />
                {label}
              </button>
            );
          })}
        </div>
      </div>

      <TerminalColorSchemes />

      <FontSettings />
    </div>
  );
}
