/**
 * The worktree's sessions, as the terminal's /resume lists them (the ones started in the terminal
 * included), newest first, searchable. Enter resumes the session in this panel; with Fork chosen,
 * it branches it under a new session instead, leaving the original as it was.
 */
import { GitBranchIcon, MessagesSquareIcon } from "lucide-react";
import { useMemo, useState } from "react";

import type { AgentSessionSummary } from "@/api/agent-session-model";
import { PickerDialog } from "@/components/ui/picker-dialog";
import { dayjs } from "@/lib/dayjs";
import { cn } from "@/lib/utils";

export type SessionAction = "resume" | "fork";

/** Sessions matching every word of `query` in their title, first prompt or branch. */
export function filterSessions(
  sessions: readonly AgentSessionSummary[],
  query: string,
): AgentSessionSummary[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return sessions.filter((session) => {
    const haystack = [session.title, session.firstPrompt, session.branch]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return words.every((word) => haystack.includes(word));
  });
}

export function AgentSessionPicker({
  isOpen,
  sessions,
  currentSessionId,
  onClose,
  onOpen,
}: {
  isOpen: boolean;
  /** Null while the list loads. */
  sessions: readonly AgentSessionSummary[] | null;
  currentSessionId: string | null;
  onClose: () => void;
  onOpen: (sessionId: string, action: SessionAction) => void;
}) {
  const [query, setQuery] = useState("");
  const [action, setAction] = useState<SessionAction>("resume");
  const items = useMemo(() => filterSessions(sessions ?? [], query), [sessions, query]);

  return (
    <PickerDialog
      name="agent-sessions"
      isOpen={isOpen}
      onClose={onClose}
      query={query}
      onQueryChange={setQuery}
      placeholder={action === "fork" ? "Fork a session…" : "Resume a session…"}
      items={items}
      getKey={(session) => session.id}
      onAccept={(session) => onOpen(session.id, action)}
      emptyState={
        <div className="text-muted-foreground px-3 py-6 text-center text-[13px]">
          {sessions === null
            ? "Loading sessions…"
            : query
              ? "No session matches"
              : "No earlier sessions in this worktree"}
        </div>
      }
      renderItem={(session) => (
        <div className="flex min-w-0 flex-col gap-0.5 py-0.5 text-left">
          <span className="text-foreground truncate text-[13px]">
            {session.title ?? session.firstPrompt ?? "Untitled session"}
            {session.id === currentSessionId && (
              <span className="text-ring ml-2 text-[11px]">this panel</span>
            )}
          </span>
          {session.title && session.firstPrompt && (
            <span className="text-muted-foreground truncate text-[12px]">
              {session.firstPrompt}
            </span>
          )}
          <span className="text-muted-foreground flex items-center gap-2 text-[11px]">
            <span>{dayjs(session.updatedAt).fromNow()}</span>
            <span className="flex items-center gap-0.5">
              <MessagesSquareIcon className="size-3" />
              {session.messageCount}
            </span>
            {session.branch && (
              <span className="flex min-w-0 items-center gap-0.5">
                <GitBranchIcon className="size-3 shrink-0" />
                <span className="truncate">{session.branch}</span>
              </span>
            )}
          </span>
        </div>
      )}
      footer={
        <div className="text-muted-foreground flex items-center gap-2 px-3 py-2 text-[11px]">
          <div role="radiogroup" aria-label="What Enter does" className="flex rounded-md border">
            {(["resume", "fork"] as const).map((value) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={action === value}
                onClick={() => setAction(value)}
                className={cn(
                  "px-2 py-0.5 first:rounded-l-md last:rounded-r-md",
                  action === value && "bg-foreground/[0.08] text-foreground",
                )}
              >
                {value === "resume" ? "Resume" : "Fork"}
              </button>
            ))}
          </div>
          <span>
            {action === "resume"
              ? "Enter continues the session here"
              : "Enter starts a new session from it; the original stays as it is"}
          </span>
        </div>
      }
    />
  );
}
