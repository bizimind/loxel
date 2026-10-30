import { realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";

import { logger } from "./logger";

const log = logger.child("schema-service");

const REMOTE_TTL_MS = 60 * 60 * 1000; // 1 hour
/** What a language server may be handed. */
const MAX_REMOTE_BYTES = 64 * 1024 * 1024; // 64 MB
/** What goes inline to Monaco's JSON worker. */
const MAX_INLINE_BYTES = 5 * 1024 * 1024; // 5 MB
const MAX_REDIRECTS = 5;

interface CacheEntry {
  schema: unknown;
  /** Revalidate when mtime changes. */
  mtimeMs: number;
}

/**
 * Server-side schema resolver with in-memory caching.
 *
 * Supports remote HTTP(S) URLs, absolute file paths, and relative paths
 * resolved against a caller-supplied base directory.
 */
export class SchemaService {
  private cache = new Map<string, CacheEntry>();
  private remoteCache = new Map<string, { text: string; fetchedAt: number }>();

  /** `mayFollowRedirect` decides each hop: a redirect can lead anywhere its server chooses. */
  constructor(private readonly mayFollowRedirect: (from: string, to: string) => boolean) {}

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

  /** Download a remote schema's text, whatever its format, cached for an hour. */
  async fetchText(url: string): Promise<string | null> {
    const cached = this.remoteCache.get(url);
    if (cached && Date.now() - cached.fetchedAt < REMOTE_TTL_MS) return cached.text;

    const text = await this.download(url);
    if (text === null) return null;
    this.remoteCache.set(url, { text, fetchedAt: Date.now() });
    log.debug("Cached remote schema", { url });
    return text;
  }

  /** Invalidate a specific cache entry. */
  invalidate(key: string): void {
    this.cache.delete(key);
    this.remoteCache.delete(key);
  }

  /** Clear all cached schemas. */
  clear(): void {
    this.cache.clear();
    this.remoteCache.clear();
  }

  // ---------------------------------------------------------------------------

  private async resolveRemote(url: string): Promise<unknown> {
    const text = await this.fetchText(url);
    if (text === null) return null;
    if (text.length > MAX_INLINE_BYTES) {
      log.warn("Schema body too large, skipping", { url, bytes: text.length });
      return null;
    }
    try {
      return JSON.parse(text);
    } catch (err) {
      log.warn("Remote schema is not JSON", { url, error: err instanceof Error ? err : undefined });
      return null;
    }
  }

  private async download(url: string): Promise<string | null> {
    try {
      const res = await this.fetchFollowing(url);
      if (!res) return null;
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
      return text;
    } catch (err) {
      log.warn("Failed to resolve remote schema", {
        url,
        error: err instanceof Error ? err : undefined,
      });
      return null;
    }
  }

  /** Fetch `url`, following only the redirects allowed; null when one is not. */
  private async fetchFollowing(url: string): Promise<Response | null> {
    const signal = AbortSignal.timeout(10_000);
    let current = url;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const res = await fetch(current, {
        headers: { Accept: "application/json, application/schema+json, */*;q=0.1" },
        redirect: "manual",
        signal,
      });
      const location = res.headers.get("location");
      if (res.status < 300 || res.status >= 400 || !location) return res;
      const next = new URL(location, current).href;
      if (!this.mayFollowRedirect(current, next)) {
        log.info("Not following a schema redirect", { from: current, to: next });
        return null;
      }
      current = next;
    }
    log.warn("Too many schema redirects", { url });
    return null;
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
      this.cache.set(realPath, { schema, mtimeMs });
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
