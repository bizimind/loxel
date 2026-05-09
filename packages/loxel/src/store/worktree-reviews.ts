/**
 * Per-worktree review state (review selection, active review).
 * Each worktree gets its own store instance via the worktree store factory.
 */
import type { Review, ReviewContext } from "@/api/review-model";

import * as api from "@/api/client";
import { frontendLog } from "@/lib/frontend-logger";

import { getActiveWt } from "./active-worktree";
import { createWorktreeStore } from "./worktree-store";

const log = frontendLog.child("ui");

interface ReviewState {
  reviews: Review[];
  /** Which reviews to overlay on the diff */
  selectedReviewIds: string[];
  /** The review that receives new comments */
  activeReviewId: string | null;
  loading: boolean;

  fetchReviews: () => Promise<void>;
  createReview: (name: string, context: ReviewContext) => Promise<Review>;
  deleteReview: (id: string) => Promise<void>;
  renameReview: (id: string, name: string) => Promise<void>;
  toggleReviewSelection: (id: string) => void;
  setActiveReview: (id: string | null) => void;
}

export const {
  useStore: useReviewStore,
  getCurrent: getCurrentReviewStore,
  purge: purgeReviewWorktree,
} = createWorktreeStore<ReviewState>((set) => ({
  reviews: [],
  selectedReviewIds: [],
  activeReviewId: null,
  loading: false,

  fetchReviews: async () => {
    let wt: string;
    try {
      wt = getActiveWt();
    } catch {
      return;
    }
    set({ loading: true });
    try {
      const reviews = await api.getReviews(wt);
      set({ reviews, loading: false });
    } catch (err) {
      log.error("Failed to fetch reviews", { error: err instanceof Error ? err : undefined });
      set({ loading: false });
    }
  },

  createReview: async (name, context) => {
    const wt = getActiveWt();
    try {
      const review = await api.createReview(wt, { name, context });
      set((s) => ({
        reviews: [review, ...s.reviews],
        selectedReviewIds: [...s.selectedReviewIds, review.id],
        activeReviewId: review.id,
      }));
      return review;
    } catch (err) {
      log.error("Failed to create review", { error: err instanceof Error ? err : undefined });
      throw err;
    }
  },

  deleteReview: async (id) => {
    const wt = getActiveWt();
    await api.deleteReview(wt, id);
    set((s) => ({
      reviews: s.reviews.filter((r) => r.id !== id),
      selectedReviewIds: s.selectedReviewIds.filter((rid) => rid !== id),
      activeReviewId: s.activeReviewId === id ? null : s.activeReviewId,
    }));
  },

  renameReview: async (id, name) => {
    const wt = getActiveWt();
    const updated = await api.updateReview(wt, id, { name });
    set((s) => ({ reviews: s.reviews.map((r) => (r.id === id ? updated : r)) }));
  },

  toggleReviewSelection: (id) => {
    set((s) => {
      if (s.selectedReviewIds.includes(id)) {
        return {
          selectedReviewIds: s.selectedReviewIds.filter((rid) => rid !== id),
          activeReviewId: s.activeReviewId === id ? null : s.activeReviewId,
        };
      }
      return {
        selectedReviewIds: [...s.selectedReviewIds, id],
        activeReviewId: s.activeReviewId ?? id,
      };
    });
  },

  setActiveReview: (id) => {
    set((s) => {
      if (id && !s.selectedReviewIds.includes(id)) {
        return { activeReviewId: id, selectedReviewIds: [...s.selectedReviewIds, id] };
      }
      return { activeReviewId: id };
    });
  },
}));
