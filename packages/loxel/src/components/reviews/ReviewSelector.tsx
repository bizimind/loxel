import { CheckIcon, MessageSquarePlusIcon, PencilIcon, StarIcon, Trash2Icon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import type { Review, ReviewContext } from "@/api/review-model";

import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { cn } from "@/lib/utils";
import { useQueryScope } from "@/queries/use-scope";
import { useReviewStore } from "@/store/worktree-reviews";

interface ReviewSelectorProps {
  /** Context for creating a new review (current diff info) */
  defaultContext: ReviewContext;
  /** Default name for new reviews */
  defaultName: string;
}

export function ReviewSelector({ defaultContext, defaultName }: ReviewSelectorProps) {
  const { activeProjectPath } = useQueryScope();
  const reviews = useReviewStore((s) => s.reviews);
  const selectedIds = useReviewStore((s) => s.selectedReviewIds);
  const activeId = useReviewStore((s) => s.activeReviewId);
  const fetchReviews = useReviewStore((s) => s.fetchReviews);
  const createReview = useReviewStore((s) => s.createReview);
  const toggleSelection = useReviewStore((s) => s.toggleReviewSelection);
  const setActive = useReviewStore((s) => s.setActiveReview);
  const deleteReview = useReviewStore((s) => s.deleteReview);
  const renameReview = useReviewStore((s) => s.renameReview);

  const [open, setOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [creating, setCreating] = useState(false);
  const [createName, setCreateName] = useState("");
  const [deletingReviewId, setDeletingReviewId] = useState<string | null>(null);
  const triggerRef = useRef<HTMLDivElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const createInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (activeProjectPath) fetchReviews();
  }, [fetchReviews, activeProjectPath]);

  // Close dropdown on outside click (check both trigger and portaled dropdown)
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        triggerRef.current &&
        !triggerRef.current.contains(target) &&
        dropdownRef.current &&
        !dropdownRef.current.contains(target)
      ) {
        setOpen(false);
        setEditingId(null);
        setCreating(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const handleStartCreate = useCallback(() => {
    setCreating(true);
    setCreateName(defaultName);
    requestAnimationFrame(() => createInputRef.current?.select());
  }, [defaultName]);

  const handleConfirmCreate = useCallback(async () => {
    const name = createName.trim();
    if (!name) return;
    await createReview(name, defaultContext);
    setCreating(false);
    setCreateName("");
    setOpen(false);
  }, [createName, createReview, defaultContext]);

  const handleRename = useCallback(
    async (id: string) => {
      if (editName.trim()) {
        await renameReview(id, editName.trim());
      }
      setEditingId(null);
    },
    [editName, renameReview],
  );

  const handleDeleteClick = useCallback((id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setDeletingReviewId(id);
  }, []);

  const handleConfirmDelete = useCallback(async () => {
    if (!deletingReviewId) return;
    await deleteReview(deletingReviewId);
    setDeletingReviewId(null);
  }, [deletingReviewId, deleteReview]);

  const selectedCount = selectedIds.length;
  const activeReview = reviews.find((r) => r.id === activeId);

  // Sort reviews by relevance to current context
  const sortedReviews = sortByRelevance(reviews, defaultContext);

  // Compute dropdown position anchored to trigger button
  const dropdownStyle = useMemo(() => {
    if (!open || !triggerRef.current) return {};
    const rect = triggerRef.current.getBoundingClientRect();
    return {
      position: "fixed" as const,
      top: rect.bottom + 4,
      right: window.innerWidth - rect.right,
      zIndex: 9999,
    };
  }, [open]);

  return (
    <div ref={triggerRef}>
      {/* Trigger button */}
      <button
        className={cn(
          "flex items-center gap-1 rounded px-2 py-0.5 text-[10px] transition-colors",
          selectedCount > 0
            ? "bg-comment-bg text-comment-marker hover:bg-comment-bg/80"
            : "text-muted-foreground hover:bg-muted hover:text-foreground",
        )}
        onClick={() => setOpen(!open)}
      >
        <MessageSquarePlusIcon className="size-3" />
        {selectedCount > 0 ? (
          <>
            {activeReview?.name ?? "Reviews"}
            {selectedCount > 1 && ` +${selectedCount - 1}`}
          </>
        ) : (
          "Reviews"
        )}
      </button>

      {/* Dropdown — portaled to body to escape overflow:hidden containers */}
      {open &&
        createPortal(
          <div
            ref={dropdownRef}
            className="bg-popover border-border w-64 rounded-lg border shadow-lg"
            style={dropdownStyle}
          >
            <div className="border-border flex items-center justify-between border-b px-3 py-2">
              <span className="text-foreground text-[11px] font-medium">Reviews</span>
              <Button variant="ghost" size="icon-xs" onClick={handleStartCreate} title="New review">
                <MessageSquarePlusIcon className="size-3.5" />
              </Button>
            </div>

            {/* Create review form */}
            {creating && (
              <div className="border-border border-b px-3 py-2">
                <input
                  ref={createInputRef}
                  className="bg-muted border-border text-foreground w-full rounded border px-2 py-1 text-[11px] focus:ring-1 focus:ring-[var(--ring)] focus:outline-none"
                  value={createName}
                  onChange={(e) => setCreateName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleConfirmCreate();
                    if (e.key === "Escape") setCreating(false);
                  }}
                  placeholder="Review name..."
                  autoFocus
                />
                <div className="mt-1.5 flex items-center justify-end gap-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 px-2 text-[11px]"
                    onClick={() => setCreating(false)}
                  >
                    Cancel
                  </Button>
                  <Button
                    variant="default"
                    size="sm"
                    className="h-6 px-2 text-[11px]"
                    onClick={handleConfirmCreate}
                    disabled={!createName.trim()}
                  >
                    Create
                  </Button>
                </div>
              </div>
            )}

            <div className="max-h-64 scrollbar-thin overflow-auto">
              {sortedReviews.length === 0 ? (
                <div className="text-muted-foreground px-3 py-4 text-center text-[11px]">
                  No reviews yet
                </div>
              ) : (
                sortedReviews.map((review) => {
                  const isSelected = selectedIds.includes(review.id);
                  const isActive = review.id === activeId;

                  return (
                    <div
                      key={review.id}
                      className={cn(
                        "border-border flex items-center gap-1.5 border-b px-3 py-1.5 last:border-b-0",
                        isSelected ? "bg-muted/30" : "hover:bg-muted/10",
                      )}
                    >
                      {/* Checkbox */}
                      <button
                        className={cn(
                          "flex size-4 shrink-0 items-center justify-center rounded border",
                          isSelected
                            ? "border-comment-marker bg-comment-bg"
                            : "border-border hover:border-muted-foreground",
                        )}
                        onClick={() => toggleSelection(review.id)}
                        title={isSelected ? "Deselect" : "Select"}
                      >
                        {isSelected && <CheckIcon className="text-comment-marker size-3" />}
                      </button>

                      {/* Name (editable) */}
                      <div className="min-w-0 flex-1">
                        {editingId === review.id ? (
                          <input
                            className="bg-muted border-border text-foreground w-full rounded border px-1 py-0.5 text-[11px] focus:outline-none"
                            value={editName}
                            onChange={(e) => setEditName(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") handleRename(review.id);
                              if (e.key === "Escape") setEditingId(null);
                            }}
                            onBlur={() => handleRename(review.id)}
                            autoFocus
                          />
                        ) : (
                          <button
                            className="text-foreground block w-full truncate text-left text-[11px]"
                            onClick={() => {
                              if (isSelected) {
                                setActive(review.id);
                              } else {
                                toggleSelection(review.id);
                              }
                            }}
                            title={review.name}
                          >
                            {review.name}
                            {review.threadCount !== undefined && review.threadCount > 0 && (
                              <span className="text-muted-foreground ml-1">
                                ({review.threadCount})
                              </span>
                            )}
                          </button>
                        )}
                      </div>

                      {/* Active star */}
                      {isSelected && (
                        <button
                          className={cn(
                            "shrink-0",
                            isActive
                              ? "text-comment-marker"
                              : "text-muted-foreground/30 hover:text-muted-foreground",
                          )}
                          onClick={() => setActive(review.id)}
                          title={isActive ? "Active review" : "Set as active"}
                        >
                          <StarIcon className={cn("size-3", isActive && "fill-current")} />
                        </button>
                      )}

                      {/* Edit button */}
                      {editingId !== review.id && (
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          onClick={() => {
                            setEditingId(review.id);
                            setEditName(review.name);
                          }}
                          title="Rename"
                        >
                          <PencilIcon className="size-3" />
                        </Button>
                      )}

                      {/* Delete button */}
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        onClick={(e) => handleDeleteClick(review.id, e)}
                        title="Delete review"
                      >
                        <Trash2Icon className="size-3" />
                      </Button>
                    </div>
                  );
                })
              )}
            </div>

            {/* Quick create at bottom */}
            {sortedReviews.length > 0 && !creating && (
              <div className="border-border border-t">
                <button
                  className="text-muted-foreground hover:bg-muted/20 hover:text-foreground flex w-full items-center gap-1.5 px-3 py-2 text-[11px] transition-colors"
                  onClick={handleStartCreate}
                >
                  <MessageSquarePlusIcon className="size-3" />
                  New Review
                </button>
              </div>
            )}
          </div>,
          document.body,
        )}

      <ConfirmDialog
        open={deletingReviewId !== null}
        title="Delete review"
        description={`Delete "${reviews.find((r) => r.id === deletingReviewId)?.name ?? "this review"}" and all its comments? This cannot be undone.`}
        confirmLabel="Delete"
        destructive
        onConfirm={handleConfirmDelete}
        onCancel={() => setDeletingReviewId(null)}
      />
    </div>
  );
}

/** Sort reviews by relevance to the current diff context */
function sortByRelevance(reviews: Review[], context: ReviewContext): Review[] {
  return [...reviews].sort((a, b) => {
    const scoreA = relevanceScore(a, context);
    const scoreB = relevanceScore(b, context);
    if (scoreA !== scoreB) return scoreB - scoreA;
    return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
  });
}

function relevanceScore(review: Review, context: ReviewContext): number {
  let score = 0;

  // Exact commit overlap
  const reviewHashes = new Set(review.context.commitHashes);
  for (const hash of context.commitHashes) {
    if (reviewHashes.has(hash)) {
      score += 10;
      break;
    }
  }

  // Branch match
  if (
    review.context.branchName &&
    context.branchName &&
    review.context.branchName === context.branchName
  ) {
    score += 5;
  }

  // Worktree match
  if (
    review.context.worktreePath &&
    context.worktreePath &&
    review.context.worktreePath === context.worktreePath
  ) {
    score += 3;
  }

  return score;
}
