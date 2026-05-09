import { z } from "zod";

import { ContentAnchorSchema } from "./comment-model";

const SideSchema = z.enum(["old", "new"]);
const ThreadStatusSchema = z.enum(["open", "resolved"]);
const AnchorStatusSchema = z.enum(["exact", "relocated", "outdated", "lost"]);

/** Context metadata stored with a review for relevance sorting */
export const ReviewContextSchema = z.object({
  commitHashes: z.array(z.string()),
  branchName: z.string().nullable(),
  headCommit: z.string(),
  worktreePath: z.string().nullable(),
});

export type ReviewContext = z.infer<typeof ReviewContextSchema>;

/** A named container for comment threads (like a code review session) */
export const ReviewSchema = z.object({
  id: z.string(),
  name: z.string(),
  context: ReviewContextSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  threadCount: z.number().optional(),
});

export type Review = z.infer<typeof ReviewSchema>;

/** A comment within a thread */
export const CommentSchema = z.object({
  id: z.string(),
  threadId: z.string(),
  body: z.string(),
  authorName: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type Comment = z.infer<typeof CommentSchema>;

/** A threaded comment anchored to code via content fingerprint */
export const CommentThreadSchema = z.object({
  id: z.string(),
  reviewId: z.string(),
  filePath: z.string(),
  createdSide: SideSchema,
  contentAnchor: ContentAnchorSchema,
  startLine: z.number(),
  endLine: z.number(),
  status: ThreadStatusSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  comments: z.array(CommentSchema),
});

export type CommentThread = z.infer<typeof CommentThreadSchema>;

/** Server-computed placement for a thread in the current diff */
export const PlacedThreadSchema = CommentThreadSchema.extend({
  displaySide: SideSchema,
  displayStartLine: z.number(),
  displayEndLine: z.number(),
  anchorStatus: AnchorStatusSchema,
  /** Original content from anchor (for outdated mini-diff) */
  originalContent: z.array(z.string()).optional(),
  /** Current content from file at relocated position */
  currentContent: z.array(z.string()).optional(),
});

export type PlacedThread = z.infer<typeof PlacedThreadSchema>;

/** File context for requesting placed threads */
export const DiffFileContextSchema = z.object({
  oldPath: z.string(),
  newPath: z.string(),
  oldRef: z.string().nullable(),
  newRef: z.string().nullable(),
  worktreePath: z.string().optional(),
});

export type DiffFileContext = z.infer<typeof DiffFileContextSchema>;

/** POST /api/placed-threads request body */
export const PlacedThreadsRequestSchema = z.object({
  reviewIds: z.array(z.string()).min(1),
  files: z.array(DiffFileContextSchema),
});

export type PlacedThreadsRequest = z.infer<typeof PlacedThreadsRequestSchema>;

/** POST /api/comments/threads request body */
export const CreateThreadRequestSchema = z
  .object({
    reviewId: z.string().min(1),
    filePath: z.string().min(1),
    createdSide: SideSchema,
    contentAnchor: ContentAnchorSchema,
    startLine: z.number().int().min(1),
    endLine: z.number().int().min(1),
    body: z.string().min(1),
  })
  .refine((d) => d.endLine >= d.startLine, { message: "endLine must be >= startLine" });

export type CreateThreadRequest = z.infer<typeof CreateThreadRequestSchema>;

/** POST /api/reviews request body */
export const CreateReviewRequestSchema = z.object({
  name: z.string().min(1),
  context: ReviewContextSchema,
});

export type CreateReviewRequest = z.infer<typeof CreateReviewRequestSchema>;

/** PATCH /api/reviews/:id request body */
export const UpdateReviewRequestSchema = z.object({
  name: z.string().min(1).optional(),
  context: ReviewContextSchema.optional(),
});

export type UpdateReviewRequest = z.infer<typeof UpdateReviewRequestSchema>;

/** PATCH /api/comments/threads/:id request body */
export const UpdateThreadRequestSchema = z.object({ status: ThreadStatusSchema });

/** POST /api/comments/threads/:id/comments request body */
export const AddReplyRequestSchema = z.object({ body: z.string().min(1) });
