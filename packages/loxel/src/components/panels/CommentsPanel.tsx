import {
  AlertTriangleIcon,
  CheckCircle2Icon,
  ChevronDownIcon,
  ChevronRightIcon,
  CircleDotIcon,
  FileTextIcon,
  MessageSquareIcon,
  SendIcon,
  Trash2Icon,
} from "lucide-react";
import { useCallback, useMemo, useRef, useState } from "react";

import type { PlacedThread } from "@/api/review-model";
import { CommentMarkdown } from "@/components/comments/CommentMarkdown";
import { OutdatedDiff } from "@/components/comments/OutdatedDiff";
import { DraggablePanelHeader } from "@/components/panels/DraggablePanelHeader";
import { ReviewSelector } from "@/components/reviews/ReviewSelector";
import { Button } from "@/components/ui/button";
import { useReviewContext } from "@/hooks/useReviewContext";
import { FileTypeIcon } from "@/lib/file-icons";
import { frontendLog } from "@/lib/frontend-logger";
import { threadsToMarkdown } from "@/lib/threads-to-markdown";
import { cn } from "@/lib/utils";
import { useCommentStore } from "@/store/comments";
import { getCurrentReviewStore, useReviewStore } from "@/store/worktree-reviews";
import { useWorktreeUI } from "@/store/worktree-ui";

/**
 * Standalone dockview panel that lists all comment threads from selected reviews,
 * grouped by file path. Includes ReviewSelector header.
 */
export function CommentsPanel() {
  const placedThreadsByFile = useCommentStore((s) => s.placedThreadsByFile);
  const lostThreads = useCommentStore((s) => s.lostThreads);
  const activeThreadId = useCommentStore((s) => s.activeThreadId);
  const setActiveThread = useCommentStore((s) => s.setActiveThread);
  const selectedReviewIds = useReviewStore((s) => s.selectedReviewIds);
  const setSelectedDiffFile = useWorktreeUI((s) => s.setSelectedDiffFile);
  const { reviewContext, reviewDefaultName } = useReviewContext();

  const handleExportMarkdown = useCallback(() => {
    const { placedThreadsByFile, lostThreads } = useCommentStore.getState();
    const { reviews, selectedReviewIds } = getCurrentReviewStore().getState();

    const reviewNames = selectedReviewIds
      .map((id) => reviews.find((r) => r.id === id)?.name)
      .filter((n): n is string => n !== undefined);

    const markdown = threadsToMarkdown({ reviewNames, placedThreadsByFile, lostThreads });

    window.dispatchEvent(
      new CustomEvent("loxel-create-editor-with-content", {
        detail: { content: markdown, title: "Review Comments" },
      }),
    );
  }, []);

  // Group threads by file, sorted by file path then line number
  const fileGroups = useMemo(() => {
    const groups: Array<{ filePath: string; threads: PlacedThread[] }> = [];
    for (const [filePath, threads] of placedThreadsByFile) {
      if (threads.length > 0) {
        groups.push({
          filePath,
          threads: [...threads].sort((a, b) => a.displayStartLine - b.displayStartLine),
        });
      }
    }
    return groups.sort((a, b) => a.filePath.localeCompare(b.filePath));
  }, [placedThreadsByFile]);

  const totalThreads = useMemo(() => {
    let count = 0;
    for (const group of fileGroups) count += group.threads.length;
    return count + lostThreads.length;
  }, [fileGroups, lostThreads]);

  const handleThreadClick = useCallback(
    (thread: PlacedThread) => {
      if (activeThreadId === thread.id) {
        setActiveThread(null);
      } else {
        setActiveThread(thread.id);
        setSelectedDiffFile(thread.filePath);
      }
    },
    [activeThreadId, setActiveThread, setSelectedDiffFile],
  );

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Header with ReviewSelector */}
      <DraggablePanelHeader panelId="comments" className="flex items-center gap-1.5">
        <h2 className="text-foreground text-sm font-medium">
          Comments{totalThreads > 0 ? ` (${totalThreads})` : ""}
        </h2>
        <div className="flex-1" />
        <ReviewSelector defaultContext={reviewContext} defaultName={reviewDefaultName} />
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={handleExportMarkdown}
          disabled={totalThreads === 0}
          title="Open as markdown"
        >
          <FileTextIcon className="size-3.5" />
        </Button>
      </DraggablePanelHeader>

      {selectedReviewIds.length === 0 ? (
        <div className="text-muted-foreground flex flex-1 items-center justify-center px-4 text-center text-xs">
          Select a review to see comments
        </div>
      ) : totalThreads === 0 ? (
        <div className="text-muted-foreground flex flex-1 items-center justify-center px-4 text-center text-xs">
          No comments yet
        </div>
      ) : (
        <div className="flex-1 scrollbar-thin overflow-y-auto">
          {fileGroups.map(({ filePath, threads }) => (
            <FileThreadGroup
              key={filePath}
              filePath={filePath}
              threads={threads}
              activeThreadId={activeThreadId}
              onThreadClick={handleThreadClick}
            />
          ))}
          {lostThreads.length > 0 && (
            <LostThreadsGroup
              threads={lostThreads}
              activeThreadId={activeThreadId}
              onThreadClick={handleThreadClick}
            />
          )}
        </div>
      )}
    </div>
  );
}

// --- File thread group ---

function FileThreadGroup({
  filePath,
  threads,
  activeThreadId,
  onThreadClick,
}: {
  filePath: string;
  threads: PlacedThread[];
  activeThreadId: string | null;
  onThreadClick: (thread: PlacedThread) => void;
}) {
  const [expanded, setExpanded] = useState(true);
  const fileName = filePath.split("/").pop() ?? filePath;

  return (
    <div className="border-border border-b">
      {/* File header */}
      <button
        className="hover:bg-muted/30 flex w-full items-center gap-1.5 px-2 py-1.5 text-[11px] transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        {expanded ? (
          <ChevronDownIcon className="text-muted-foreground size-3 shrink-0" />
        ) : (
          <ChevronRightIcon className="text-muted-foreground size-3 shrink-0" />
        )}
        <FileTypeIcon filename={fileName} className="size-3.5 shrink-0" />
        <span className="text-foreground min-w-0 truncate font-medium">{filePath}</span>
        <span className="text-muted-foreground ml-auto shrink-0">({threads.length})</span>
      </button>

      {/* Thread rows */}
      {expanded &&
        threads.map((thread) => {
          const isActive = thread.id === activeThreadId;
          return (
            <div key={thread.id}>
              <ThreadRow
                thread={thread}
                isActive={isActive}
                onClick={() => onThreadClick(thread)}
              />
              {isActive && <ThreadDetail thread={thread} />}
            </div>
          );
        })}
    </div>
  );
}

// --- Thread row (collapsed summary) ---

function ThreadRow({
  thread,
  isActive,
  onClick,
}: {
  thread: PlacedThread;
  isActive: boolean;
  onClick: () => void;
}) {
  const resolveThread = useCommentStore((s) => s.resolveThread);
  const reopenThread = useCommentStore((s) => s.reopenThread);
  const deleteThread = useCommentStore((s) => s.deleteThread);

  const isResolved = thread.status === "resolved";
  const firstComment = thread.comments[0];

  return (
    <div
      className={cn(
        "flex w-full cursor-pointer flex-col gap-0.5 px-3 py-1.5 text-left text-xs transition-colors",
        isActive ? "bg-muted/50" : "hover:bg-muted/20",
      )}
      onClick={onClick}
    >
      {/* Top line: status + line range + badges + actions */}
      <div className="flex items-center gap-1.5">
        {isResolved ? (
          <CheckCircle2Icon className="text-muted-foreground size-3 shrink-0" />
        ) : (
          <CircleDotIcon className="text-comment-marker size-3 shrink-0" />
        )}
        <span
          className={cn(
            "text-[11px] font-medium",
            isResolved ? "text-muted-foreground" : "text-foreground",
          )}
        >
          L{thread.displayStartLine}
          {thread.displayEndLine > thread.displayStartLine && `–${thread.displayEndLine}`}
        </span>
        <AnchorBadge status={thread.anchorStatus} />
        <div className="flex-1" />
        {thread.comments.length > 1 && (
          <span className="text-muted-foreground text-[10px]">
            <MessageSquareIcon className="mr-0.5 inline size-2.5" />
            {thread.comments.length}
          </span>
        )}
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={(e) => {
            e.stopPropagation();
            const op = isResolved ? reopenThread(thread.id) : resolveThread(thread.id);
            op.catch((err: unknown) =>
              frontendLog
                .child("ui")
                .error("Failed to update thread status", {
                  threadId: thread.id,
                  error: err instanceof Error ? err : undefined,
                }),
            );
          }}
          title={isResolved ? "Reopen" : "Resolve"}
        >
          {isResolved ? (
            <CircleDotIcon className="size-3" />
          ) : (
            <CheckCircle2Icon className="size-3" />
          )}
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={(e) => {
            e.stopPropagation();
            deleteThread(thread.id).catch((err: unknown) =>
              frontendLog
                .child("ui")
                .error("Failed to delete thread", {
                  threadId: thread.id,
                  error: err instanceof Error ? err : undefined,
                }),
            );
          }}
          title="Delete thread"
        >
          <Trash2Icon className="size-3" />
        </Button>
      </div>

      {/* Preview of first comment */}
      {firstComment && (
        <p
          className={cn(
            "line-clamp-2 pl-[18px] text-[11px] leading-snug",
            isResolved ? "text-muted-foreground/60" : "text-muted-foreground",
          )}
        >
          {firstComment.body}
        </p>
      )}
    </div>
  );
}

// --- Thread detail (expanded view with comments + reply) ---

function ThreadDetail({ thread }: { thread: PlacedThread }) {
  const addReply = useCommentStore((s) => s.addReply);

  const [replyBody, setReplyBody] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const handleReply = useCallback(async () => {
    if (!replyBody.trim()) return;
    setSubmitting(true);
    try {
      await addReply(thread.id, replyBody.trim());
      setReplyBody("");
      requestAnimationFrame(() => textareaRef.current?.focus());
    } catch (err) {
      frontendLog
        .child("ui")
        .error("Failed to add reply", {
          threadId: thread.id,
          error: err instanceof Error ? err : undefined,
        });
    } finally {
      setSubmitting(false);
    }
  }, [replyBody, thread.id, addReply]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        handleReply();
      }
    },
    [handleReply],
  );

  return (
    <div className="bg-muted/20 border-border border-t">
      {/* All comments */}
      {thread.comments.map((comment) => (
        <div key={comment.id} className="border-border border-b px-3 py-2 last:border-b-0">
          <CommentMarkdown content={comment.body} />
          <div className="text-muted-foreground mt-1 text-right text-[10px]">
            {comment.authorName ?? "Anonymous"}, {formatTimestamp(comment.createdAt)}
          </div>
        </div>
      ))}

      {/* Outdated content diff */}
      {thread.anchorStatus === "outdated" && thread.originalContent && (
        <div className="px-3 py-2">
          <OutdatedDiff originalContent={thread.originalContent} />
        </div>
      )}

      {/* Reply input */}
      <div className="border-border border-t p-2">
        <textarea
          ref={textareaRef}
          className="bg-muted border-border text-foreground placeholder:text-muted-foreground w-full resize-none rounded border p-2 text-xs focus:ring-1 focus:ring-[var(--ring)] focus:outline-none"
          rows={2}
          placeholder="Reply..."
          value={replyBody}
          onChange={(e) => setReplyBody(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={submitting}
        />
        <div className="mt-1.5 flex items-center justify-between">
          <span className="text-muted-foreground/60 text-[10px]">
            {/Mac|iPhone/.test(navigator.userAgent) ? "Cmd" : "Ctrl"}+Enter
          </span>
          <Button
            variant="default"
            size="sm"
            className="h-6 gap-1 px-2 text-[11px]"
            onClick={handleReply}
            disabled={!replyBody.trim() || submitting}
          >
            <SendIcon className="size-3" />
            Reply
          </Button>
        </div>
      </div>
    </div>
  );
}

// --- Lost threads group ---

function LostThreadsGroup({
  threads,
  activeThreadId,
  onThreadClick,
}: {
  threads: PlacedThread[];
  activeThreadId: string | null;
  onThreadClick: (thread: PlacedThread) => void;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="border-border border-b">
      <button
        className="text-muted-foreground hover:bg-muted/30 flex w-full items-center gap-1.5 px-2 py-1.5 text-[11px] transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        {expanded ? (
          <ChevronDownIcon className="size-3 shrink-0" />
        ) : (
          <ChevronRightIcon className="size-3 shrink-0" />
        )}
        <AlertTriangleIcon className="size-3 shrink-0 text-amber-500" />
        <span className="text-amber-600 dark:text-amber-400">
          {threads.length} lost comment{threads.length > 1 ? "s" : ""}
        </span>
      </button>
      {expanded &&
        threads.map((thread) => {
          const isActive = thread.id === activeThreadId;
          return (
            <div key={thread.id}>
              <div
                className={cn(
                  "border-border cursor-pointer border-t px-3 py-2 text-xs transition-colors",
                  isActive ? "bg-muted/50" : "hover:bg-muted/20",
                )}
                onClick={() => onThreadClick(thread)}
              >
                <div className="text-muted-foreground mb-1 text-[10px]">
                  {thread.filePath} · L{thread.startLine}
                  {thread.endLine > thread.startLine && `–L${thread.endLine}`}
                  {" · "}
                  {thread.createdSide === "old" ? "parent" : "current"} side
                </div>
                <pre className="bg-muted/50 text-muted-foreground/80 max-h-16 overflow-hidden rounded p-1.5 text-[10px] leading-tight">
                  {thread.contentAnchor.content.join("\n")}
                </pre>
                <div className="text-foreground mt-1">
                  {thread.comments[0]?.body.slice(0, 100)}
                  {(thread.comments[0]?.body.length ?? 0) > 100 && "..."}
                </div>
              </div>
              {isActive && <ThreadDetail thread={thread} />}
            </div>
          );
        })}
    </div>
  );
}

// --- Anchor status badge ---

function AnchorBadge({ status }: { status: PlacedThread["anchorStatus"] }) {
  if (status === "exact") return null;

  if (status === "outdated") {
    return (
      <span className="flex items-center gap-0.5 rounded bg-amber-500/15 px-1 py-0.5 text-[9px] text-amber-600 dark:text-amber-400">
        <AlertTriangleIcon className="size-2.5" />
        Outdated
      </span>
    );
  }

  if (status === "relocated") {
    return (
      <span className="rounded bg-blue-500/15 px-1 py-0.5 text-[9px] text-blue-600 dark:text-blue-400">
        Relocated
      </span>
    );
  }

  if (status === "lost") {
    return (
      <span className="flex items-center gap-0.5 rounded bg-red-500/15 px-1 py-0.5 text-[9px] text-red-600 dark:text-red-400">
        <AlertTriangleIcon className="size-2.5" />
        Lost
      </span>
    );
  }

  return null;
}

// --- Helpers ---

function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMin = Math.floor(diffMs / 60_000);

  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;

  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;

  const diffDays = Math.floor(diffHr / 24);
  if (diffDays < 7) return `${diffDays}d ago`;

  return date.toLocaleDateString();
}
