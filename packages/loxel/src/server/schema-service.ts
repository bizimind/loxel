import { realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";

import { logger } from "./logger";

const log = logger.child("schema-service");

const REMOTE_TTL_MS = 60 * 60 * 1000; // 1 hour
const MAX_REMOTE_BYTES = 5 * 1024 * 1024; // 5 MB

interface CacheEntry {
  schema: unknown;
  fetchedAt: number;
  /** For local files — revalidate when mtime changes. */
  mtimeMs?: number;
}

/**
 * Server-side schema resolver with in-memory caching.
 *
 * Supports remote HTTP(S) URLs, absolute file paths, and relative paths
 * resolved against a caller-supplied base directory.
 */
export class SchemaService {
  private cache = new Map<string, CacheEntry>();

  /** Resolve a schema URL or file path. Returns parsed JSON or `null` on failure. */
  async resolve(urlOrPath: string, baseDir?: string): Promise<unknown> {
    if (urlOrPath.startsWith("http://") || urlOrPath.startsWith("https://")) {
      return this.resolveRemote(urlOrPath);
    }

    // Reject non-HTTP URL schemes (e.g. file://, ftp://)
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(urlOrPath)) {
      log.warn("Rejected schema with unsupported URL scheme", { url: urlOrPath });
      return null;
    }

    // Local file — resolve relative paths against baseDir
    const absPath = urlOrPath.startsWith("/") ? urlOrPath : resolve(baseDir ?? ".", urlOrPath);
    return this.resolveLocal(absPath);
  }

  /** Invalidate a specific cache entry. */
  invalidate(key: string): void {
    this.cache.delete(key);
  }

  /** Clear all cached schemas. */
  clear(): void {
    this.cache.clear();
  }

  // ---------------------------------------------------------------------------

  private async resolveRemote(url: string): Promise<unknown> {
    const cached = this.cache.get(url);
    if (cached && Date.now() - cached.fetchedAt < REMOTE_TTL_MS) {
      return cached.schema;
    }

    try {
      const res = await fetch(url, {
        headers: { Accept: "application/json, application/schema+json" },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        log.warn("Schema fetch failed", { url, status: res.status });
        return null;
      }

      const contentLength = res.headers.get("content-length");
      if (contentLength && parseInt(contentLength, 10) > MAX_REMOTE_BYTES) {
        log.warn("Schema too large, skipping", { url, bytes: contentLength });
        return null;
      }

      const text = await res.text();
      if (text.length > MAX_REMOTE_BYTES) {
        log.warn("Schema body too large, skipping", { url, bytes: text.length });
        return null;
      }

      const schema: unknown = JSON.parse(text);
      this.cache.set(url, { schema, fetchedAt: Date.now() });
      log.debug("Cached remote schema", { url });
      return schema;
    } catch (err) {
      log.warn("Failed to resolve remote schema", {
        url,
        error: err instanceof Error ? err : undefined,
      });
      return null;
    }
  }

  private async resolveLocal(absPath: string): Promise<unknown> {
    try {
      const realPath = await realpath(absPath);
      const fileStat = await stat(realPath);
      const mtimeMs = fileStat.mtimeMs;

      const cached = this.cache.get(realPath);
      if (cached && cached.mtimeMs === mtimeMs) {
        return cached.schema;
      }

      const file = Bun.file(realPath);
      const text = await file.text();
      const schema: unknown = JSON.parse(text);
      this.cache.set(realPath, { schema, fetchedAt: Date.now(), mtimeMs });
      log.debug("Cached local schema", { path: realPath });
      return schema;
    } catch (err) {
      log.warn("Failed to resolve local schema", {
        path: absPath,
        error: err instanceof Error ? err : undefined,
      });
      return null;
    }
  }
}
