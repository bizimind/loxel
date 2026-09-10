import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";

import { z } from "zod";

import type { ContentAnchor } from "@/api/comment-model";
import { ContentAnchorSchema } from "@/api/comment-model";
import type { Comment, CommentThread, Review, ReviewContext } from "@/api/review-model";
import { ReviewContextSchema } from "@/api/review-model";

import { config } from "./config";

/**
 * Compute a stable repo hash from git's common dir.
 * Uses --git-common-dir so all worktrees of the same repo share one comment DB.
 */
async function getRepoHash(cwd: string): Promise<string> {
  const result = await Bun.$`git -C ${cwd} rev-parse --git-common-dir`.text();
  const gitCommonDir = result.trim();
  const resolved = realpathSync(
    gitCommonDir.startsWith("/") ? gitCommonDir : join(cwd, gitCommonDir),
  );
  return createHash("sha256").update(resolved).digest("hex").slice(0, 32);
}

/** Get the git author name from git config */
export async function getGitAuthorName(cwd: string): Promise<string | null> {
  try {
    const result = await Bun.$`git -C ${cwd} config user.name`.nothrow().text();
    const name = result.trim();
    return name || null;
  } catch {
    return null;
  }
}

// --- Zod schemas for SQLite row validation ---

const ReviewRowSchema = z.object({
  id: z.string(),
  name: z.string(),
  context: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
});
type ReviewRow = z.infer<typeof ReviewRowSchema>;

const ReviewRowWithCountSchema = ReviewRowSchema.extend({ thread_count: z.number() });

const ThreadRowSchema = z.object({
  id: z.string(),
  review_id: z.string(),
  file_path: z.string(),
  created_side: z.enum(["old", "new"]),
  content_anchor: z.string(),
  start_line: z.number(),
  end_line: z.number(),
  status: z.enum(["open", "resolved"]),
  created_at: z.string(),
  updated_at: z.string(),
});
type ThreadRow = z.infer<typeof ThreadRowSchema>;

const CommentRowSchema = z.object({
  id: z.string(),
  thread_id: z.string(),
  body: z.string(),
  author_name: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});
type CommentRow = z.infer<typeof CommentRowSchema>;

const ThreadLookupSchema = z.object({ id: z.string(), review_id: z.string() });

const UserVersionSchema = z.object({ user_version: z.number() });
const CountSchema = z.object({ cnt: z.number() });

// --- Row-to-model mapping ---

function reviewRowToModel(row: ReviewRow, threadCount?: number): Review {
  const review: Review = {
    id: row.id,
    name: row.name,
    context: ReviewContextSchema.parse(JSON.parse(row.context)),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (threadCount !== undefined) review.threadCount = threadCount;
  return review;
}

function threadRowToModel(row: ThreadRow, comments: Comment[]): CommentThread {
  return {
    id: row.id,
    reviewId: row.review_id,
    filePath: row.file_path,
    createdSide: row.created_side,
    contentAnchor: ContentAnchorSchema.parse(JSON.parse(row.content_anchor)),
    startLine: row.start_line,
    endLine: row.end_line,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    comments,
  };
}

function commentRowToModel(row: CommentRow): Comment {
  return {
    id: row.id,
    threadId: row.thread_id,
    body: row.body,
    authorName: row.author_name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class ReviewDb {
  private db: Database;

  private constructor(db: Database) {
    this.db = db;
  }

  static async open(cwd: string): Promise<ReviewDb> {
    if (!existsSync(config.commentsDir)) {
      mkdirSync(config.commentsDir, { recursive: true });
    }

    const repoHash = await getRepoHash(cwd);
    const dbPath = join(config.commentsDir, `${repoHash}.db`);

    const db = new Database(dbPath);
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec("PRAGMA foreign_keys = ON");

    const instance = new ReviewDb(db);
    instance.migrateToV2();
    return instance;
  }

  /**
   * Migrate to schema v2 (review-based comments).
   * Since the comment system hasn't shipped, we drop old tables and recreate.
   */
  private migrateToV2(): void {
    const { user_version: version } = UserVersionSchema.parse(
      this.db.prepare("PRAGMA user_version").get(),
    );

    if (version < 2) {
      // Drop old scope-based tables if they exist
      this.db.exec("DROP TABLE IF EXISTS comments");
      this.db.exec("DROP TABLE IF EXISTS comment_threads");

      // Create new review-based schema
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS reviews (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          context TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS comment_threads (
          id TEXT PRIMARY KEY,
          review_id TEXT NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
          file_path TEXT NOT NULL,
          created_side TEXT NOT NULL CHECK (created_side IN ('old', 'new')),
          content_anchor TEXT NOT NULL,
          start_line INTEGER NOT NULL CHECK (start_line >= 1),
          end_line INTEGER NOT NULL CHECK (end_line >= start_line),
          status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS comments (
          id TEXT PRIMARY KEY,
          thread_id TEXT NOT NULL REFERENCES comment_threads(id) ON DELETE CASCADE,
          body TEXT NOT NULL,
          author_name TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_threads_review ON comment_threads(review_id);
        CREATE INDEX IF NOT EXISTS idx_threads_file ON comment_threads(file_path);
        CREATE INDEX IF NOT EXISTS idx_comments_thread ON comments(thread_id);
      `);

      this.db.exec("PRAGMA user_version = 2");
    }
  }

  // --- Reviews ---

  listReviews(): Review[] {
    const rows = this.db
      .prepare(
        `SELECT r.*, COUNT(ct.id) as thread_count
         FROM reviews r
         LEFT JOIN comment_threads ct ON ct.review_id = r.id
         GROUP BY r.id
         ORDER BY r.updated_at DESC`,
      )
      .all();

    return rows.map((raw) => {
      const row = ReviewRowWithCountSchema.parse(raw);
      return reviewRowToModel(row, row.thread_count);
    });
  }

  createReview(name: string, context: ReviewContext): Review {
    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    const contextJson = JSON.stringify(context);

    this.db
      .prepare(
        "INSERT INTO reviews (id, name, context, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(id, name, contextJson, now, now);

    return { id, name, context, createdAt: now, updatedAt: now, threadCount: 0 };
  }

  updateReview(id: string, updates: { name?: string; context?: ReviewContext }): Review | null {
    const now = new Date().toISOString();
    const raw = this.db.prepare("SELECT * FROM reviews WHERE id = ?").get(id);
    if (!raw) return null;
    const row = ReviewRowSchema.parse(raw);

    const name = updates.name ?? row.name;
    const context = updates.context ? JSON.stringify(updates.context) : row.context;

    this.db
      .prepare("UPDATE reviews SET name = ?, context = ?, updated_at = ? WHERE id = ?")
      .run(name, context, now, id);

    const { cnt: count } = CountSchema.parse(
      this.db.prepare("SELECT COUNT(*) as cnt FROM comment_threads WHERE review_id = ?").get(id),
    );

    return reviewRowToModel({ ...row, name, context, updated_at: now }, count);
  }

  deleteReview(id: string): boolean {
    const result = this.db.prepare("DELETE FROM reviews WHERE id = ?").run(id);
    return result.changes > 0;
  }

  // --- Threads ---

  /** List threads for given review IDs, optionally filtered by file paths */
  listThreads(reviewIds: string[], filePaths?: string[]): CommentThread[] {
    if (reviewIds.length === 0) return [];

    const reviewPlaceholders = reviewIds.map(() => "?").join(", ");
    let query = `SELECT * FROM comment_threads WHERE review_id IN (${reviewPlaceholders})`;
    let params: (string | number)[] = [...reviewIds];

    if (filePaths && filePaths.length > 0) {
      const pathPlaceholders = filePaths.map(() => "?").join(", ");
      query += ` AND file_path IN (${pathPlaceholders})`;
      params = [...params, ...filePaths];
    }

    query += " ORDER BY file_path, start_line";

    const threadRows = this.db
      .prepare(query)
      .all(...params)
      .map((raw) => ThreadRowSchema.parse(raw));

    return threadRows.map((row) => {
      const commentRows = this.db
        .prepare("SELECT * FROM comments WHERE thread_id = ? ORDER BY created_at")
        .all(row.id)
        .map((raw) => CommentRowSchema.parse(raw));
      return threadRowToModel(row, commentRows.map(commentRowToModel));
    });
  }

  /** Create a thread with its first comment (atomic transaction) */
  createThread(params: {
    reviewId: string;
    filePath: string;
    createdSide: "old" | "new";
    contentAnchor: ContentAnchor;
    startLine: number;
    endLine: number;
    body: string;
    authorName: string | null;
  }): CommentThread {
    const now = new Date().toISOString();
    const threadId = crypto.randomUUID();
    const commentId = crypto.randomUUID();
    const contentAnchorJson = JSON.stringify(params.contentAnchor);

    const insertThread = this.db.prepare(
      `INSERT INTO comment_threads (id, review_id, file_path, created_side, content_anchor, start_line, end_line, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`,
    );

    const insertComment = this.db.prepare(
      `INSERT INTO comments (id, thread_id, body, author_name, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );

    const updateReview = this.db.prepare("UPDATE reviews SET updated_at = ? WHERE id = ?");

    const txn = this.db.transaction(() => {
      insertThread.run(
        threadId,
        params.reviewId,
        params.filePath,
        params.createdSide,
        contentAnchorJson,
        params.startLine,
        params.endLine,
        now,
        now,
      );
      insertComment.run(commentId, threadId, params.body, params.authorName, now, now);
      updateReview.run(now, params.reviewId);
    });

    txn();

    return {
      id: threadId,
      reviewId: params.reviewId,
      filePath: params.filePath,
      createdSide: params.createdSide,
      contentAnchor: params.contentAnchor,
      startLine: params.startLine,
      endLine: params.endLine,
      status: "open",
      createdAt: now,
      updatedAt: now,
      comments: [
        {
          id: commentId,
          threadId,
          body: params.body,
          authorName: params.authorName,
          createdAt: now,
          updatedAt: now,
        },
      ],
    };
  }

  /** Add a reply to an existing thread */
  addReply(threadId: string, body: string, authorName: string | null): Comment {
    const now = new Date().toISOString();
    const commentId = crypto.randomUUID();

    const threadRaw = this.db
      .prepare("SELECT id, review_id FROM comment_threads WHERE id = ?")
      .get(threadId);
    if (!threadRaw) {
      throw new Error(`Thread ${threadId} not found`);
    }
    const { review_id: reviewId } = ThreadLookupSchema.parse(threadRaw);

    const txn = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO comments (id, thread_id, body, author_name, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(commentId, threadId, body, authorName, now, now);
      this.db.prepare("UPDATE comment_threads SET updated_at = ? WHERE id = ?").run(now, threadId);
      this.db.prepare("UPDATE reviews SET updated_at = ? WHERE id = ?").run(now, reviewId);
    });

    txn();

    return { id: commentId, threadId, body, authorName, createdAt: now, updatedAt: now };
  }

  /** Update thread status (resolve/reopen) */
  updateThread(threadId: string, status: "open" | "resolved"): CommentThread | null {
    const now = new Date().toISOString();

    const result = this.db
      .prepare("UPDATE comment_threads SET status = ?, updated_at = ? WHERE id = ?")
      .run(status, now, threadId);

    if (result.changes === 0) return null;

    const row = ThreadRowSchema.parse(
      this.db.prepare("SELECT * FROM comment_threads WHERE id = ?").get(threadId),
    );

    const commentRows = this.db
      .prepare("SELECT * FROM comments WHERE thread_id = ? ORDER BY created_at")
      .all(threadId)
      .map((raw) => CommentRowSchema.parse(raw));

    return threadRowToModel(row, commentRows.map(commentRowToModel));
  }

  /** Delete a thread and all its comments (cascade) */
  deleteThread(threadId: string): boolean {
    const result = this.db.prepare("DELETE FROM comment_threads WHERE id = ?").run(threadId);
    return result.changes > 0;
  }

  close(): void {
    this.db.close();
  }
}
