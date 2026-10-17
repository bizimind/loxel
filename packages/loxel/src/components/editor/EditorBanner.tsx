import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

const TONE_CLASSES = {
  warning: {
    bar: "border-yellow-600/50 bg-yellow-900/50 text-yellow-200",
    button: "bg-yellow-700/60 hover:bg-yellow-700/80",
  },
  info: {
    bar: "border-sky-600/50 bg-sky-950/60 text-sky-200",
    button: "bg-sky-800/60 hover:bg-sky-800/80",
  },
  danger: {
    bar: "border-red-600/50 bg-red-900/40 text-red-200",
    button: "bg-red-700/60 hover:bg-red-700/80",
  },
} as const;

export interface EditorBannerAction {
  label: string;
  onClick: () => void;
}

interface EditorBannerProps {
  tone: keyof typeof TONE_CLASSES;
  message: ReactNode;
  actions: EditorBannerAction[];
}

/** Thin status bar above a file-backed editor (conflicts, deleted files) with inline actions. */
export function EditorBanner({ tone, message, actions }: EditorBannerProps) {
  const classes = TONE_CLASSES[tone];
  return (
    <div className={cn("flex items-center gap-2 border-b px-3 py-1.5 text-xs", classes.bar)}>
      <span className="flex-1">{message}</span>
      {actions.map((action) => (
        <button
          key={action.label}
          onClick={action.onClick}
          className={cn("rounded px-2 py-0.5", classes.button)}
        >
          {action.label}
        </button>
      ))}
    </div>
  );
}
