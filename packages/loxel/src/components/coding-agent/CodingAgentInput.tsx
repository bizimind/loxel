/**
 * Message input area for coding agent panels.
 * Auto-growing textarea with send and stop buttons.
 *
 * Supports two send modes while agent is running:
 * - **Steer** (Enter): cancels current run, sends message immediately
 * - **Queue** (Cmd/Ctrl+Enter): waits for run to finish, then sends
 */
import { ClockIcon, SendIcon, SquareIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import type { AgentStatus } from "@/api/ws-protocol";
import { cn } from "@/lib/utils";

interface CodingAgentInputProps {
  onSend: (text: string) => void;
  onStop: () => void;
  /** Steer: cancel current run then send. */
  onSteer: (text: string) => void;
  /** Queue: send after current run completes. */
  onQueue: (text: string) => void;
  /** Cancel a previously queued message. */
  onCancelQueue: () => void;
  status: AgentStatus;
  queuedMessage: string | null;
  /** Pre-fill text from rewind. Consumed once on change. */
  draftText: string | null;
  onDraftConsumed: () => void;
  /** Ref exposed for parent-driven focus (e.g. panel activation). */
  inputRef?: React.RefObject<HTMLTextAreaElement | null>;
}

export function CodingAgentInput({
  onSend,
  onStop,
  onSteer,
  onQueue,
  onCancelQueue,
  status,
  queuedMessage,
  draftText,
  onDraftConsumed,
  inputRef,
}: CodingAgentInputProps) {
  const [text, setText] = useState("");
  const internalRef = useRef<HTMLTextAreaElement>(null);
  const textareaRef = inputRef ?? internalRef;

  // Pre-fill from rewind draft
  useEffect(() => {
    if (draftText !== null) {
      setText(draftText);
      onDraftConsumed();
      // Focus and auto-grow the textarea
      const el = textareaRef.current;
      if (el) {
        el.style.height = "auto";
        el.style.height = Math.min(el.scrollHeight, 150) + "px";
        el.focus();
      }
    }
  }, [draftText, onDraftConsumed]);

  const canSend = status === "ready" || status === "waiting";
  const isRunning = status === "running";
  const isDisabled = status === "starting" || status === "exited";
  const hasText = text.trim().length > 0;

  const clearInput = useCallback(() => {
    setText("");
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
  }, []);

  const handleSend = useCallback(() => {
    const trimmed = text.trim();
    if (!trimmed || !canSend) return;
    onSend(trimmed);
    clearInput();
  }, [text, canSend, onSend, clearInput]);

  const handleSteer = useCallback(() => {
    const trimmed = text.trim();
    if (!trimmed || !isRunning) return;
    onSteer(trimmed);
    clearInput();
  }, [text, isRunning, onSteer, clearInput]);

  const handleQueue = useCallback(() => {
    const trimmed = text.trim();
    if (!trimmed || !isRunning) return;
    onQueue(trimmed);
    clearInput();
  }, [text, isRunning, onQueue, clearInput]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey && !(e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        if (isRunning) {
          handleSteer();
        } else {
          handleSend();
        }
      } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !e.shiftKey) {
        e.preventDefault();
        if (isRunning) {
          handleQueue();
        } else {
          handleSend();
        }
      }
    },
    [isRunning, handleSend, handleSteer, handleQueue],
  );

  const handleInput = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setText(e.target.value);
    // Auto-grow
    const el = e.target;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 150) + "px";
  }, []);

  const placeholder = isRunning
    ? "Steer agent (Enter) or queue (Cmd+Enter)..."
    : status === "exited"
      ? "Session ended"
      : "Send a message...";

  return (
    <div className="bg-editor-surface flex flex-col gap-0 p-2 pt-0">
      {/* Queued message indicator */}
      {queuedMessage && (
        <div className="text-muted-foreground flex items-center gap-2 px-1 pb-1 text-xs">
          <ClockIcon className="size-3 shrink-0" />
          <span className="min-w-0 flex-1 truncate">Queued: {queuedMessage}</span>
          <button
            type="button"
            onClick={onCancelQueue}
            className="text-muted-foreground hover:text-foreground shrink-0 underline"
          >
            Cancel
          </button>
        </div>
      )}

      <div className="flex items-end gap-2">
        <textarea
          ref={textareaRef}
          value={text}
          onChange={handleInput}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          disabled={isDisabled}
          rows={2}
          className="bg-background border-border min-h-[36px] flex-1 resize-none rounded-lg border px-3 py-2 text-sm outline-none placeholder:text-gray-500 focus:ring-1 focus:ring-blue-500/30 disabled:opacity-50"
        />
        {isRunning ? (
          <div className="flex shrink-0 gap-1">
            {hasText ? (
              <>
                <button
                  type="button"
                  onClick={handleSteer}
                  title="Steer — redirect agent with new message (Enter)"
                  className={cn(
                    "bg-primary text-primary-foreground flex size-9 items-center justify-center rounded-lg transition-colors",
                  )}
                >
                  <SendIcon className="size-4" />
                </button>
                <button
                  type="button"
                  onClick={handleQueue}
                  title="Queue — send after agent finishes (Cmd+Enter)"
                  className="text-muted-foreground hover:text-foreground hover:bg-primary/50 flex size-9 items-center justify-center rounded-lg transition-colors"
                >
                  <ClockIcon className="size-4" />
                </button>
              </>
            ) : (
              <button
                type="button"
                onClick={onStop}
                title="Stop agent"
                className="text-destructive hover:bg-destructive/10 flex size-9 shrink-0 items-center justify-center rounded-lg transition-colors"
              >
                <SquareIcon className="size-4" />
              </button>
            )}
          </div>
        ) : (
          <button
            type="button"
            onClick={handleSend}
            disabled={!canSend || !hasText}
            title="Send message"
            className="bg-primary text-primary-foreground flex size-9 shrink-0 items-center justify-center rounded-lg transition-colors disabled:opacity-50"
          >
            <SendIcon className="size-4" />
          </button>
        )}
      </div>
    </div>
  );
}
