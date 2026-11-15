import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/** Light: a pale tinted strip with dark tinted text; dark: a deep tinted strip with light text. */
const TONE_CLASSES = {
  warning: {
    bar: "border-amber-300 bg-amber-50 text-amber-900 dark:border-yellow-600/50 dark:bg-yellow-900/50 dark:text-yellow-200",
    button: "bg-amber-200/70 hover:bg-amber-200 dark:bg-yellow-700/60 dark:hover:bg-yellow-700/80",
  },
  info: {
    bar: "border-sky-300 bg-sky-50 text-sky-900 dark:border-sky-600/50 dark:bg-sky-950/60 dark:text-sky-200",
    button: "bg-sky-200/70 hover:bg-sky-200 dark:bg-sky-800/60 dark:hover:bg-sky-800/80",
  },
  danger: {
    bar: "border-red-300 bg-red-50 text-red-900 dark:border-red-600/50 dark:bg-red-900/40 dark:text-red-200",
    button: "bg-red-200/70 hover:bg-red-200 dark:bg-red-700/60 dark:hover:bg-red-700/80",
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
