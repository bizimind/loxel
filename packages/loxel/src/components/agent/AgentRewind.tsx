/**
 * Rewind, as in the terminal: Escape twice picks the last message, Up and Down pick another,
 * Enter asks what to restore (the code, the conversation, or both, as of just before that
 * message), and Escape leaves. A rewound conversation puts the message back in the composer.
 */
import { HistoryIcon } from "lucide-react";
import { useEffect, useRef } from "react";

import type { RewindPreview, TranscriptItem } from "@/api/agent-session-model";

import { Shortcut } from "./AgentRequestCard";

type UserItem = Extract<TranscriptItem, { kind: "user" }>;

/** The messages a rewind can go back to: sent, and recorded by the agent. */
export function rewindableMessages(items: readonly TranscriptItem[]): UserItem[] {
  return items.filter(
    (item): item is UserItem => item.kind === "user" && !item.queued && item.resumeAt !== undefined,
  );
}

/** How long two Escapes may be apart to count as one double Escape. */
export const DOUBLE_ESCAPE_MS = 500;

export interface RewindChoice {
  code: boolean;
  conversation: boolean;
}

function previewText(preview: RewindPreview | undefined): string {
  if (!preview) return "Checking which files changed…";
  if (!preview.available || preview.files.length === 0) return "No file changes to restore";
  const n = preview.files.length;
  return `${n} file${n === 1 ? "" : "s"} · +${preview.insertions} −${preview.deletions}`;
}

export function RewindCard({
  message,
  preview,
  onChoose,
  onCancel,
}: {
  message: UserItem;
  preview: RewindPreview | undefined;
  onChoose: (choice: RewindChoice) => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // The user asked for this card with the keyboard, so it takes focus for its shortcuts.
  useEffect(() => ref.current?.focus(), []);
  const code = preview?.available === true && preview.files.length > 0;
  const options: { label: string; choice: RewindChoice | null }[] = [
    ...(code
      ? [{ label: "Restore code and conversation", choice: { code: true, conversation: true } }]
      : []),
    { label: "Restore conversation", choice: { code: false, conversation: true } },
    ...(code ? [{ label: "Restore code", choice: { code: true, conversation: false } }] : []),
    { label: "Never mind", choice: null },
  ];
  const pick = (index: number) => {
    const option = options[index];
    if (!option) return;
    if (option.choice) onChoose(option.choice);
    else onCancel();
  };

  return (
    <div
      ref={ref}
      tabIndex={-1}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          onCancel();
          return;
        }
        const n = /^[1-9]$/.test(e.key) ? Number(e.key) - 1 : e.key === "Enter" ? 0 : -1;
        if (n >= 0) {
          e.preventDefault();
          e.stopPropagation();
          pick(n);
        }
      }}
      className="bg-popover ring-ring/35 focus-within:ring-ring/70 mb-2 rounded-xl p-4 shadow-lg ring-1 outline-none"
    >
      <div className="text-ring mb-1 flex items-center gap-1.5 text-[11px] font-medium tracking-wide uppercase">
        <HistoryIcon className="size-3" /> Rewind
      </div>
      <div className="text-foreground mb-1 text-[15px] font-semibold">
        Go back to before this message?
      </div>
      <p className="text-muted-foreground mb-1 line-clamp-2 text-[13px] italic">“{message.text}”</p>
      <p className="text-muted-foreground mb-3 text-[12px]">
        Code since then: {previewText(preview)}
      </p>
      <div className="flex flex-wrap gap-2">
        {options.map((option, i) => (
          <button
            key={option.label}
            type="button"
            onClick={() => pick(i)}
            className={
              i === 0
                ? "bg-primary text-primary-foreground hover:bg-primary/90 flex h-8 items-center rounded-md px-3 text-xs font-medium"
                : "border-border hover:bg-foreground/[0.05] flex h-8 items-center rounded-md border px-3 text-xs font-medium"
            }
          >
            {option.label}
            <Shortcut n={i + 1} />
          </button>
        ))}
      </div>
    </div>
  );
}
