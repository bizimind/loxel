import {
  AddReplyRequestSchema,
  CreateReviewRequestSchema,
  CreateThreadRequestSchema,
  PlacedThreadsRequestSchema,
  UpdateReviewRequestSchema,
  UpdateThreadRequestSchema,
} from "@/api/review-model";

import type { ReviewDb } from "./review-db";

import { placeThreads } from "./placement";
import { error, json } from "./response-helpers";

interface ReviewRouteContext {
  reviewDb: ReviewDb;
  cwd: string;
  authorName: string | null;
}

/** GET /api/reviews */
function handleListReviews(_req: Request, ctx: ReviewRouteContext): Response {
  const reviews = ctx.reviewDb.listReviews();
  return json(reviews);
}

/** POST /api/reviews */
async function handleCreateReview(req: Request, ctx: ReviewRouteContext): Promise<Response> {
  const body: unknown = await req.json();
  const result = CreateReviewRequestSchema.safeParse(body);
  if (!result.success) return error(result.error.issues[0]?.message ?? "Invalid request");

  const review = ctx.reviewDb.createReview(result.data.name.trim(), result.data.context);
  return json(review, 201);
}

/** PATCH /api/reviews/:id */
async function handleUpdateReview(
  req: Request,
  ctx: ReviewRouteContext,
  reviewId: string,
): Promise<Response> {
  const body: unknown = await req.json();
  const result = UpdateReviewRequestSchema.safeParse(body);
  if (!result.success) return error(result.error.issues[0]?.message ?? "Invalid request");

  const review = ctx.reviewDb.updateReview(reviewId, result.data);
  if (!review) return error("Review not found", 404);

  return json(review);
}

/** DELETE /api/reviews/:id */
function handleDeleteReview(_req: Request, ctx: ReviewRouteContext, reviewId: string): Response {
  const deleted = ctx.reviewDb.deleteReview(reviewId);
  if (!deleted) return error("Review not found", 404);
  return json({ success: true });
}

/** POST /api/placed-threads */
async function handlePlacedThreads(req: Request, ctx: ReviewRouteContext): Promise<Response> {
  const body: unknown = await req.json();
  const result = PlacedThreadsRequestSchema.safeParse(body);
  if (!result.success) return error(result.error.issues[0]?.message ?? "Invalid request");

  const { reviewIds, files } = result.data;

  // Collect all file paths for querying
  const allPaths = new Set<string>();
  for (const file of files) {
    allPaths.add(file.oldPath);
    allPaths.add(file.newPath);
  }

  const threads = ctx.reviewDb.listThreads(reviewIds, [...allPaths]);
  const placed = await placeThreads(ctx.cwd, threads, files);

  return json(placed);
}

/** POST /api/comments/threads — create thread + first comment */
async function handleCreateThread(req: Request, ctx: ReviewRouteContext): Promise<Response> {
  const body: unknown = await req.json();
  const result = CreateThreadRequestSchema.safeParse(body);
  if (!result.success) return error(result.error.issues[0]?.message ?? "Invalid request");

  const d = result.data;
  const thread = ctx.reviewDb.createThread({
    reviewId: d.reviewId,
    filePath: d.filePath,
    createdSide: d.createdSide,
    contentAnchor: d.contentAnchor,
    startLine: d.startLine,
    endLine: d.endLine,
    body: d.body.trim(),
    authorName: ctx.authorName,
  });

  return json(thread, 201);
}

/** POST /api/comments/threads/:id/comments — add reply */
async function handleAddReply(
  req: Request,
  ctx: ReviewRouteContext,
  threadId: string,
): Promise<Response> {
  const body: unknown = await req.json();
  const result = AddReplyRequestSchema.safeParse(body);
  if (!result.success) return error(result.error.issues[0]?.message ?? "Invalid request");

  try {
    const comment = ctx.reviewDb.addReply(threadId, result.data.body.trim(), ctx.authorName);
    return json(comment, 201);
  } catch (err) {
    if (err instanceof Error && err.message.includes("not found")) {
      return error(err.message, 404);
    }
    throw err;
  }
}

/** PATCH /api/comments/threads/:id — resolve/reopen */
async function handleUpdateThread(
  req: Request,
  ctx: ReviewRouteContext,
  threadId: string,
): Promise<Response> {
  const body: unknown = await req.json();
  const result = UpdateThreadRequestSchema.safeParse(body);
  if (!result.success) return error(result.error.issues[0]?.message ?? "Invalid request");

  const thread = ctx.reviewDb.updateThread(threadId, result.data.status);
  if (!thread) return error("Thread not found", 404);

  return json(thread);
}

/** DELETE /api/comments/threads/:id */
function handleDeleteThread(_req: Request, ctx: ReviewRouteContext, threadId: string): Response {
  const deleted = ctx.reviewDb.deleteThread(threadId);
  if (!deleted) return error("Thread not found", 404);
  return json({ success: true });
}

/** Route review/comment API requests. Returns null if the path doesn't match. */
export async function handleReviewRequest(
  req: Request,
  ctx: ReviewRouteContext,
): Promise<Response | null> {
  const url = new URL(req.url);
  const { pathname } = url;
  const method = req.method;

  // GET /api/reviews
  if (method === "GET" && pathname === "/api/reviews") {
    return handleListReviews(req, ctx);
  }

  // POST /api/reviews
  if (method === "POST" && pathname === "/api/reviews") {
    return handleCreateReview(req, ctx);
  }

  // PATCH/DELETE /api/reviews/:id
  const reviewIdMatch = pathname.match(/^\/api\/reviews\/([^/]+)$/);
  if (reviewIdMatch) {
    const reviewId = reviewIdMatch[1]!;
    if (method === "PATCH") return handleUpdateReview(req, ctx, reviewId);
    if (method === "DELETE") return handleDeleteReview(req, ctx, reviewId);
  }

  // POST /api/placed-threads
  if (method === "POST" && pathname === "/api/placed-threads") {
    return handlePlacedThreads(req, ctx);
  }

  // POST /api/comments/threads
  if (method === "POST" && pathname === "/api/comments/threads") {
    return handleCreateThread(req, ctx);
  }

  // Routes with thread ID parameter
  const threadIdMatch = pathname.match(/^\/api\/comments\/threads\/([^/]+)$/);
  if (threadIdMatch) {
    const threadId = threadIdMatch[1]!;
    if (method === "PATCH") return handleUpdateThread(req, ctx, threadId);
    if (method === "DELETE") return handleDeleteThread(req, ctx, threadId);
  }

  // POST /api/comments/threads/:id/comments
  const replyMatch = pathname.match(/^\/api\/comments\/threads\/([^/]+)\/comments$/);
  if (replyMatch && method === "POST") {
    const threadId = replyMatch[1]!;
    return handleAddReply(req, ctx, threadId);
  }

  return null;
}
